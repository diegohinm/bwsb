import { env } from "../config/env.js";
import { ACTIVE_REDDIT_COMMUNITIES } from "../config/redditCommunities.js";
import {
  activeCommunities,
  canRunRedditIngestion,
  runtimeConfigStatus,
} from "../services/reddit/redditRuntimeConfig.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { getUsMarketSessionStatus } from "../services/market/usMarketCalendar.js";
import { formatUsd } from "../services/reddit/mindcaseBudget.service.js";
import { boundsForArchive, boundsForPosts } from "../services/reddit/redditSyncPlan.js";
import {
  logSync,
  postsIntervalMs,
  runSyncUntilCurrent,
} from "../services/reddit/redditSync.service.js";
import {
  benchPrimaryIfLagging,
  decisionIsPaused,
  PRIMARY_SOURCE,
  describeRedditRouting,
  fetchForSource,
  overlapSecondsFor,
  primaryFailurePolicy,
  resolveSourceFor,
} from "../services/reddit/redditSourceRouter.js";
import { meteredRedditFetcher } from "../services/reddit/meteredRedditFetcher.js";

/**
 * WORKER JOB — post discovery for the ingested communities.
 *
 * POSTS ARE A DISCOVERY STREAM, not a latency-sensitive one. Their job is to
 * find threads: the Daily Discussion, the Tomorrow and Weekend megathreads, and
 * ordinary posts worth reading comments from. Nobody is watching for a post to
 * appear within seconds, so ten minutes is ample and one minute would be four
 * hundred wasted requests a day.
 *
 * THE SOURCE IS NOT CHOSEN HERE. This job asks the router which upstream owns
 * the stream this cycle and uses whatever it is handed. That indirection is the
 * point: when the job resolved its own provider from the social factory, the
 * free archive could be configured as primary while every scheduled run still
 * went to the metered client, and both settings looked correct in isolation.
 *
 * ONE COMMUNITY, TODAY. `redditConfig.ingestionCommunities` defaults to
 * wallstreetbets alone. The previous sweep iterated `redditConfig.subreddits` —
 * five communities — at 50 rows each, every ten minutes: 250 billable rows per
 * cycle for content of which only wallstreetbets was ever displayed. The
 * multi-community support is untouched; what changed is that being TRACKED no
 * longer means being PAID FOR.
 */

export async function syncRedditPosts(): Promise<JobMetadata> {
  const market = getUsMarketSessionStatus();

  // SCOPE COMES FROM THE BACKEND, and if it cannot be verified nothing runs.
  // `activeCommunities()` returns an empty array when unauthorised, so there is
  // no value it could return that would widen what we fetch.
  if (!canRunRedditIngestion()) {
    const status = runtimeConfigStatus();
    console.warn(
      "[reddit-ingestion] SKIPPED — runtime config unavailable; no Mindcase requests made.",
    );
    return { status: "skipped", reason: "runtime config unavailable", ...status };
  }

  const communities = activeCommunities();
  if (communities.length === 0) {
    return { status: "skipped", reason: "no active communities" };
  }

  let rowsReceived = 0;
  let newItems = 0;
  let duplicates = 0;
  let estimatedCostUsd = 0;
  const failed: string[] = [];
  const paused: string[] = [];
  const sources: string[] = [];
  const policy = primaryFailurePolicy();

  for (const community of communities) {
    const resource = { community, stream: "POSTS" as const, threadId: "" };

    // WHO SERVES THIS CYCLE — one decision, read from durable state, made
    // before any request is built. The budget check for the metered path lives
    // inside this call, so it happens before that provider is ever reached.
    const decision = await resolveSourceFor(resource);
    if (decisionIsPaused(decision)) {
      console.warn(
        `[reddit/posts sync] PAUSED community=${community} reason=${decision.reason}. ` +
          `No upstream request made; the API keeps serving stored data.`,
      );
      paused.push(community);
      continue;
    }
    sources.push(decision.source);

    const isPrimary = decision.source === PRIMARY_SOURCE;
    const pages = await runSyncUntilCurrent({
      community,
      contentType: "POSTS",
      threadId: "",
      priority: 0,
      // A community's post stream is never retired. It is the only thing that
      // discovers new threads, so letting it go quiet would end ingestion.
      isProtected: true,
      baseIntervalMs: postsIntervalMs(),
      // A free source asks for a full page; a metered one is sized from what
      // the last request actually yielded, because there every row is billed.
      bounds: isPrimary ? boundsForArchive() : boundsForPosts(),
      source: decision.source,
      overlapSeconds: overlapSecondsFor(decision.source),
      failureThreshold: policy.failureThreshold,
      cooldownMs: policy.cooldownMs,
      // Catch-up is for the free source only. Paging a metered provider after
      // downtime is how an outage turns into an invoice.
      maxPages: isPrimary ? env.ARCTIC_SHIFT_MAX_PAGES_PER_SYNC : 1,
      fetch: (maxResults, window) =>
        fetchForSource({
          decision,
          resource,
          maxResults,
          window,
          deps: { metered: meteredRedditFetcher },
        }),
    });

    for (const result of pages) {
      logSync("posts", market.isRegularSessionOpen, result);
      rowsReceived += result.rowsReceived;
      newItems += result.newItems;
      duplicates += result.duplicates;
      estimatedCostUsd += result.estimatedCostUsd;
      if (result.error) failed.push(community);
    }

    const last = pages[pages.length - 1];
    if (last && !last.error) {
      // Lag is judged only on a cycle that actually succeeded: a failed fetch
      // reports no lag, and a failure is already counted as a failure.
      await benchPrimaryIfLagging({ resource, lagSeconds: last.lagSeconds });
    }
  }

  // Nothing new is the NORMAL outcome of a ten-minute poll on a quiet hour, not
  // a failure — and it is the cheap outcome, which is the point.
  const quiet = newItems === 0;
  return {
    ...(quiet ? { status: "success_without_change" as const } : {}),
    communities,
    sources,
    ...(paused.length > 0 ? { paused } : {}),
    marketOpen: market.isRegularSessionOpen,
    rowsReceived,
    newItems,
    duplicates,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    efficiencyPercent: rowsReceived > 0 ? Math.round((newItems / rowsReceived) * 100) : 0,
    failed,
  };
}

/**
 * One-line startup declaration of what this worker will actually spend.
 *
 * Printed once, at boot, because the single most useful thing to see in a log
 * after a cost incident is what the process BELIEVED its configuration was.
 */
export function describeRedditIngestion(): string {
  return [
    "[reddit-ingestion]",
    describeRedditRouting(),
    `communities=${ACTIVE_REDDIT_COMMUNITIES.join(",") || "none"}`,
    `postsInterval=${env.REDDIT_POSTS_INTERVAL_MINUTES}m`,
    `commentsMarketOpenInterval=${env.REDDIT_COMMENTS_MARKET_OPEN_INTERVAL_MINUTES}m`,
    `commentsMarketClosedInterval=${env.REDDIT_COMMENTS_MARKET_CLOSED_INTERVAL_MINUTES}m`,
    "marketTimezone=America/New_York",
    `costPerRowUsd=${env.MINDCASE_COST_PER_RESULT_USD}`,
    `postsLimit=${env.REDDIT_POSTS_FETCH_LIMIT}`,
    `commentsLimit=${env.REDDIT_COMMENTS_FETCH_LIMIT}`,
    `threadsPerSync=${env.REDDIT_COMMENT_THREADS_PER_SYNC}`,
    `dailyBudget=${formatUsd(env.MINDCASE_MAX_ESTIMATED_COST_PER_DAY_USD)}`,
  ].join(" ");
}

if (isMainModule(import.meta.url)) {
  await runJobAsScript("syncRedditPosts", syncRedditPosts);
}
