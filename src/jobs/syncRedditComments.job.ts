import { env } from "../config/env.js";
import {
  activeCommunities,
  canRunRedditIngestion,
  runtimeConfigStatus,
} from "../services/reddit/redditRuntimeConfig.js";
import { prisma } from "../lib/prisma.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { getUsMarketSessionStatus } from "../services/market/usMarketCalendar.js";
import {
  boundsForArchive,
  boundsForComments,
  intervalForPriority,
} from "../services/reddit/redditSyncPlan.js";
import {
  commentIntervalMs,
  logSync,
  runSync,
  runSyncUntilCurrent,
} from "../services/reddit/redditSync.service.js";
import {
  benchPrimaryIfLagging,
  decisionIsPaused,
  fetchForSource,
  FALLBACK_SOURCE,
  overlapSecondsFor,
  PRIMARY_SOURCE,
  primaryFailurePolicy,
  resolveSourceFor,
} from "../services/reddit/redditSourceRouter.js";
import { meteredRedditFetcher } from "../services/reddit/meteredRedditFetcher.js";
import { DAILY_DISCUSSION_WINDOW_HOURS } from "../services/social/dailyDiscussion.service.js";

/**
 * WORKER JOB — incremental comment sync.
 *
 * "EVERY MINUTE" MEANS AN INCREMENTAL ATTEMPT ON A FEW THREADS, not a reload of
 * r/wallstreetbets. The distinction is the entire budget: a subreddit-wide
 * comment crawl at 50 rows a minute is 72,000 billable rows a day, about $360.
 * What actually happens per minute is a small request against the handful of
 * threads people are currently writing in, sized from what the last one yielded.
 *
 * TWO SHAPES, BECAUSE THE TWO SOURCES BILL DIFFERENTLY.
 *
 * The PRIMARY archive is free and supports an ascending, community-wide `after`
 * query, so one request per tick returns every new comment in the community
 * regardless of which thread it landed in. That is both cheaper — one request
 * instead of one per thread — and strictly more complete, because it cannot
 * miss a conversation that was never picked for a rotation.
 *
 * The METERED fallback bills per row and its comments agent takes a thread URL,
 * so a community-wide crawl there would return whatever the crawler found
 * across every thread, most of it from conversations nobody is reading, at the
 * same price per row as the megathread. Naming the thread is what makes a
 * one-minute cadence affordable on that path — so the rotation below survives
 * as the FALLBACK shape only.
 *
 * PRIORITIES, because not every thread deserves every minute:
 *   P0  the live Daily / Tomorrow / Weekend megathread — every tick
 *   P1  recent posts with real comment activity
 *   P2  everything else recent
 * and a thread that returns nothing for several runs leaves the rotation
 * entirely (see redditSyncPlan.shouldRetire). Without that the sweep would grow
 * without bound as threads accumulate, and the bill with it.
 */

type CommentTarget = {
  community: string;
  /** Reddit's bare post id — what the comments URL is built from. */
  threadId: string;
  priority: number;
  /** Megathreads are never retired for going quiet overnight. */
  isProtected: boolean;
};

/**
 * Which threads to spend on this tick.
 *
 * Ordered by priority and bounded by REDDIT_COMMENT_THREADS_PER_SYNC, so one
 * run's cost is knowable in advance: at most `threads × maxResults` rows.
 *
 * Threads whose cursor says they are not due yet, or have been retired, are
 * excluded here rather than fetched and discarded — the cheapest request is the
 * one never made.
 */
export async function selectCommentTargets(
  community: string,
  limit: number,
  now = new Date(),
  provider: string = FALLBACK_SOURCE,
): Promise<CommentTarget[]> {
  const since = new Date(now.getTime() - DAILY_DISCUSSION_WINDOW_HOURS * 3_600_000);

  const [megathreads, busy, cursors] = await Promise.all([
    // P0 — the live megathreads. `discussionThreadType` was decided once at
    // ingestion, so this is an indexed filter rather than a title match.
    prisma.socialPosts.findMany({
      where: {
        subreddit: community,
        discussionThreadType: { not: null },
        postedAt: { gte: since },
        redditId: { not: null },
      },
      orderBy: { postedAt: "desc" },
      select: { redditId: true, externalId: true, commentCount: true },
      take: 3,
    }),
    // P1/P2 — recent posts, busiest first. Comment count is the provider's own
    // measure of where the conversation is.
    prisma.socialPosts.findMany({
      where: {
        subreddit: community,
        postedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
        redditId: { not: null },
      },
      orderBy: [{ commentCount: "desc" }, { postedAt: "desc" }],
      select: { redditId: true, externalId: true, commentCount: true },
      take: limit * 4,
    }),
    prisma.redditIngestionCursor.findMany({
      where: { provider, subreddit: community, contentType: "COMMENTS" },
      select: { threadId: true, nextSyncAt: true, isActive: true },
    }),
  ]);

  const state = new Map(cursors.map((c) => [c.threadId, c]));
  const due = (threadId: string): boolean => {
    const cursor = state.get(threadId);
    if (!cursor) return true; // never synced — always due
    if (!cursor.isActive) return false; // retired for going quiet
    return !cursor.nextSyncAt || cursor.nextSyncAt <= now;
  };

  const seen = new Set<string>();
  const targets: CommentTarget[] = [];

  const push = (redditId: string | null, priority: number, isProtected: boolean) => {
    const threadId = bareRedditId(redditId);
    if (!threadId || seen.has(threadId)) return;
    seen.add(threadId);
    if (!due(threadId)) return;
    targets.push({ community, threadId, priority, isProtected });
  };

  for (const post of megathreads) push(post.redditId, 0, true);
  for (const post of busy) {
    push(post.redditId, (post.commentCount ?? 0) >= 25 ? 1 : 2, false);
  }

  return targets.sort((a, b) => a.priority - b.priority).slice(0, limit);
}

/** `t3_1vi969l` → `1vi969l`. The comments URL wants the bare id. */
export function bareRedditId(value: string | null): string | null {
  if (!value) return null;
  const bare = value.replace(/^t\d_/, "").trim();
  return bare.length > 0 ? bare : null;
}

/**
 * Give freshly stored comments their parent thread's classification.
 *
 * The Discussion feed filters `type=daily_discussion` on the comment's OWN
 * `discussion_thread_type` column, deliberately denormalized so the hot query
 * needs no join. A comment written without it is invisible to that filter, so
 * inheriting it is not a nicety — skipping it silently empties the Daily
 * Discussion tab.
 *
 * Runs after persistence and is scoped to rows still missing the value, so it
 * is idempotent and costs nothing on a tick that stored nothing.
 */
async function inheritThreadTypes(threadIds: string[]): Promise<number> {
  if (threadIds.length === 0) return 0;

  return prisma.$executeRaw`
    UPDATE social_comments c
       SET discussion_thread_type = p.discussion_thread_type,
           flair_text = COALESCE(c.flair_text, p.flair_text)
      FROM social_posts p
     WHERE p.reddit_id IS NOT NULL
       AND c.post_external_id IS NOT NULL
       AND regexp_replace(p.reddit_id, '^t[0-9]_', '') = c.post_external_id
       AND c.post_external_id = ANY(${threadIds})
       AND p.discussion_thread_type IS NOT NULL
       AND c.discussion_thread_type IS DISTINCT FROM p.discussion_thread_type`;
}

export async function syncRedditComments(): Promise<JobMetadata> {
  const market = getUsMarketSessionStatus();
  const intervalMs = commentIntervalMs(market.isRegularSessionOpen);

  if (!canRunRedditIngestion()) {
    console.warn(
      "[reddit-ingestion] SKIPPED — runtime config unavailable; no upstream requests made.",
    );
    return {
      status: "skipped",
      reason: "runtime config unavailable",
      ...runtimeConfigStatus(),
    };
  }

  const communities = activeCommunities();
  if (communities.length === 0) {
    return { status: "skipped", reason: "no active communities" };
  }

  let rowsReceived = 0;
  let newItems = 0;
  let duplicates = 0;
  let estimatedCostUsd = 0;
  let threadsSynced = 0;
  let lagSeconds: number | null = null;
  const touchedThreads: string[] = [];
  const sources: string[] = [];
  const paused: string[] = [];
  const policy = primaryFailurePolicy();

  for (const community of communities) {
    // ONE decision per community per tick, read from durable state. The budget
    // check for the metered path happens inside this call, before that provider
    // could ever be reached.
    const communityResource = { community, stream: "COMMENTS" as const, threadId: "" };
    const decision = await resolveSourceFor(communityResource);

    if (decisionIsPaused(decision)) {
      console.warn(
        `[reddit/comments sync] PAUSED community=${community} reason=${decision.reason}. ` +
          `No upstream request made; the API keeps serving stored data.`,
      );
      paused.push(community);
      continue;
    }
    sources.push(decision.source);

    if (decision.source === PRIMARY_SOURCE) {
      // ── FREE, COMMUNITY-WIDE ────────────────────────────────────────────
      // One ascending request from the checkpoint returns every new comment in
      // the community. No thread selection, no per-thread cursors, no priority
      // rotation and no idle retirement: all of that machinery exists to bound
      // the number of BILLED requests, and there is nothing to bound here. It
      // is also strictly more complete — a thread that never made the rotation
      // still has its comments collected.
      const pages = await runSyncUntilCurrent({
        community,
        contentType: "COMMENTS",
        threadId: "",
        priority: 0,
        // The community-level comment stream is never retired: it is the only
        // thing collecting comments at all, so letting it go quiet overnight
        // would end comment ingestion until a restart.
        isProtected: true,
        baseIntervalMs: intervalMs,
        // Free source: always a full page. See boundsForArchive.
        bounds: boundsForArchive(),
        source: decision.source,
        overlapSeconds: overlapSecondsFor(decision.source),
        failureThreshold: policy.failureThreshold,
        cooldownMs: policy.cooldownMs,
        // Market-open bursts and post-downtime backlog both exceed one page.
        maxPages: env.ARCTIC_SHIFT_MAX_PAGES_PER_SYNC,
        fetch: (maxResults, window) =>
          fetchForSource({
            decision,
            resource: communityResource,
            maxResults,
            window,
            deps: { metered: meteredRedditFetcher },
          }),
      });

      let storedAny = false;
      for (const result of pages) {
        logSync("comments", market.isRegularSessionOpen, result);
        if (result.lagSeconds !== null) lagSeconds = result.lagSeconds;
        rowsReceived += result.rowsReceived;
        newItems += result.newItems;
        duplicates += result.duplicates;
        threadsSynced += 1;
        if (result.storedComments > 0) storedAny = true;
      }

      const last = pages[pages.length - 1];
      if (last && !last.error) {
        await benchPrimaryIfLagging({
          resource: communityResource,
          lagSeconds: last.lagSeconds,
        });
      }

      // A community-wide sweep does not know which threads it touched, so every
      // recently-active thread is offered to the inheritance pass. That query is
      // scoped to rows still missing the value, so a wider list costs nothing.
      if (storedAny) {
        const recent = await selectCommentTargets(community, 25, new Date(), PRIMARY_SOURCE);
        touchedThreads.push(...recent.map((t) => t.threadId));
      }
      continue;
    }

    // ── METERED FALLBACK, PER THREAD ──────────────────────────────────────
    // Retained unchanged: this agent takes a thread URL and bills per row, so
    // the rotation and its priority scaling are what keep the fallback from
    // costing more than the outage it is covering.
    const targets = await selectCommentTargets(
      community,
      env.REDDIT_COMMENT_THREADS_PER_SYNC,
      new Date(),
      FALLBACK_SOURCE,
    );

    for (const target of targets) {
      const resource = {
        community: target.community,
        stream: "COMMENTS" as const,
        threadId: target.threadId,
      };
      const result = await runSync({
        community: target.community,
        contentType: "COMMENTS",
        threadId: target.threadId,
        priority: target.priority,
        isProtected: target.isProtected,
        // Scaled by priority: the megathread gets the full cadence, quieter
        // threads get a fraction of it. Without this the one-minute rate would
        // apply to every thread in the rotation and multiply the bill by their
        // number, for conversations producing a comment every few minutes.
        baseIntervalMs: intervalForPriority(intervalMs, target.priority),
        bounds: boundsForComments(),
        source: decision.source,
        overlapSeconds: overlapSecondsFor(decision.source),
        fetch: (maxResults, window) =>
          fetchForSource({
            decision,
            resource,
            maxResults,
            window,
            deps: { metered: meteredRedditFetcher },
          }),
      });

      logSync("comments", market.isRegularSessionOpen, result);
      rowsReceived += result.rowsReceived;
      newItems += result.newItems;
      duplicates += result.duplicates;
      estimatedCostUsd += result.estimatedCostUsd;
      threadsSynced += 1;
      if (result.storedComments > 0) touchedThreads.push(target.threadId);
    }
  }

  // Classification inheritance is an optimization of a read, not a record of
  // anything — a failure here must not undo comments that are already stored.
  let reclassified = 0;
  try {
    reclassified = await inheritThreadTypes(touchedThreads);
  } catch (err) {
    console.error("[reddit/comments sync] thread-type inheritance failed:", err);
  }

  const quiet = newItems === 0;
  return {
    ...(quiet ? { status: "success_without_change" as const } : {}),
    communities,
    sources,
    ...(paused.length > 0 ? { paused } : {}),
    ...(lagSeconds !== null ? { archiveLagSeconds: lagSeconds } : {}),
    marketOpen: market.isRegularSessionOpen,
    marketHoliday: market.holiday,
    intervalMinutes: intervalMs / 60_000,
    threadsSynced,
    rowsReceived,
    newItems,
    duplicates,
    reclassified,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    efficiencyPercent: rowsReceived > 0 ? Math.round((newItems / rowsReceived) * 100) : 0,
  };
}

if (isMainModule(import.meta.url)) {
  await runJobAsScript("syncRedditComments", syncRedditComments);
}
