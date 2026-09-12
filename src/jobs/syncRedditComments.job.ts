import { env } from "../config/env.js";
import {
  activeCommunities,
  canRunRedditIngestion,
  runtimeConfigStatus,
} from "../services/reddit/redditRuntimeConfig.js";
import { prisma } from "../lib/prisma.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { getUsMarketSessionStatus } from "../services/market/usMarketCalendar.js";
import { getSocialDataProvider } from "../services/social/socialDataProvider.factory.js";
import { budgetAllowsSpending } from "../services/reddit/mindcaseBudget.service.js";
import { boundsForComments, intervalForPriority } from "../services/reddit/redditSyncPlan.js";
import {
  commentIntervalMs,
  logSync,
  PROVIDER,
  runSync,
} from "../services/reddit/redditSync.service.js";
import { DAILY_DISCUSSION_WINDOW_HOURS } from "../services/social/dailyDiscussion.service.js";
import type { SocialPostItem } from "../services/social/socialData.types.js";

/**
 * WORKER JOB — incremental comment sync.
 *
 * "EVERY MINUTE" MEANS AN INCREMENTAL ATTEMPT ON A FEW THREADS, not a reload of
 * r/wallstreetbets. The distinction is the entire budget: a subreddit-wide
 * comment crawl at 50 rows a minute is 72,000 billable rows a day, about $360.
 * What actually happens per minute is a small request against the handful of
 * threads people are currently writing in, sized from what the last one yielded.
 *
 * WHY BY THREAD. Mindcase bills per row returned and its comments agent takes a
 * URL. A subreddit-scoped crawl returns whatever it finds across every thread,
 * most of it from conversations nobody is reading — paid for at the same rate as
 * the megathread. Naming the thread is what makes a one-minute cadence
 * affordable at all.
 *
 * PRIORITIES, because not every thread deserves every minute:
 *   P0  the live Daily / Tomorrow / Weekend megathread — every tick
 *   P1  recent posts with real comment activity
 *   P2  everything else recent
 * and a thread that returns nothing for several runs leaves the rotation
 * entirely (see redditSyncPlan.shouldRetire). Without that the sweep would grow
 * without bound as threads accumulate, and the bill with it.
 */

type CommentFetcher = {
  name: string;
  fetchThreadComments?: (params: {
    subreddit: string;
    threadId: string;
    maxResults: number;
  }) => Promise<SocialPostItem[]>;
};

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
      where: { provider: PROVIDER, subreddit: community, contentType: "COMMENTS" },
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
      "[reddit-ingestion] SKIPPED — runtime config unavailable; no Mindcase requests made.",
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

  const budget = await budgetAllowsSpending();
  if (!budget.allowed) {
    console.warn(
      `[reddit/comments sync] SKIPPED — ${budget.reason}. ` +
        `Ingestion is paused; the API keeps serving stored data.`,
    );
    return {
      status: "skipped",
      reason: budget.reason,
      rowsToday: budget.rowsToday,
      costTodayUsd: budget.costTodayUsd,
    };
  }

  const provider = getSocialDataProvider() as unknown as CommentFetcher;
  if (typeof provider.fetchThreadComments !== "function") {
    // Not an error: a provider without a comments agent simply contributes no
    // comments, and posts ingestion carries on untouched.
    return { status: "skipped", reason: `${provider.name} has no comments agent` };
  }
  const fetchThreadComments = provider.fetchThreadComments.bind(provider);

  let rowsReceived = 0;
  let newItems = 0;
  let duplicates = 0;
  let estimatedCostUsd = 0;
  let threadsSynced = 0;
  const touchedThreads: string[] = [];

  for (const community of communities) {
    const targets = await selectCommentTargets(community, env.REDDIT_COMMENT_THREADS_PER_SYNC);

    for (const target of targets) {
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
        fetch: (maxResults) =>
          fetchThreadComments({
            subreddit: target.community,
            threadId: target.threadId,
            maxResults,
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
