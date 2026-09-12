import { env } from "../config/env.js";
import { ACTIVE_REDDIT_COMMUNITIES } from "../config/redditCommunities.js";
import {
  activeCommunities,
  canRunRedditIngestion,
  runtimeConfigStatus,
} from "../services/reddit/redditRuntimeConfig.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { getUsMarketSessionStatus } from "../services/market/usMarketCalendar.js";
import { getSocialDataProvider } from "../services/social/socialDataProvider.factory.js";
import { budgetAllowsSpending, formatUsd } from "../services/reddit/mindcaseBudget.service.js";
import { boundsForPosts } from "../services/reddit/redditSyncPlan.js";
import { logSync, postsIntervalMs, runSync } from "../services/reddit/redditSync.service.js";
import type { SocialPostItem } from "../services/social/socialData.types.js";

/**
 * WORKER JOB — post discovery for the ingested communities.
 *
 * POSTS ARE A DISCOVERY STREAM, not a latency-sensitive one. Their job is to
 * find threads: the Daily Discussion, the Tomorrow and Weekend megathreads, and
 * ordinary posts worth reading comments from. Nobody is watching for a post to
 * appear within seconds, so ten minutes is ample and one minute would be four
 * hundred wasted requests a day.
 *
 * ONE COMMUNITY, TODAY. `redditConfig.ingestionCommunities` defaults to
 * wallstreetbets alone. The previous sweep iterated `redditConfig.subreddits` —
 * five communities — at 50 rows each, every ten minutes: 250 billable rows per
 * cycle for content of which only wallstreetbets was ever displayed. The
 * multi-community support is untouched; what changed is that being TRACKED no
 * longer means being PAID FOR.
 */

/** A provider that can hand back raw items for ingestion. */
type ItemFetcher = {
  name: string;
  fetchItems?: (params: {
    subreddits?: string[];
    keyword?: string;
    maxResults?: number;
  }) => Promise<{ items: SocialPostItem[]; failed: string[]; attempted: number }>;
};

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

  // BEFORE ANY REQUEST. A budget check that runs afterwards has already paid.
  const budget = await budgetAllowsSpending();
  if (!budget.allowed) {
    console.warn(
      `[reddit/posts sync] SKIPPED — ${budget.reason}. ` +
        `Ingestion is paused; the API keeps serving stored data.`,
    );
    return {
      status: "skipped",
      reason: budget.reason,
      rowsToday: budget.rowsToday,
      costTodayUsd: budget.costTodayUsd,
    };
  }

  const provider = getSocialDataProvider() as unknown as ItemFetcher;
  if (typeof provider.fetchItems !== "function") {
    throw new Error(`Social provider "${provider.name}" cannot expose raw items for ingestion.`);
  }
  const fetchItems = provider.fetchItems.bind(provider);

  let rowsReceived = 0;
  let newItems = 0;
  let duplicates = 0;
  let estimatedCostUsd = 0;
  const failed: string[] = [];

  for (const community of communities) {
    const result = await runSync({
      community,
      contentType: "POSTS",
      threadId: "",
      priority: 0,
      // A community's post stream is never retired. It is the only thing that
      // discovers new threads, so letting it go quiet would end ingestion.
      isProtected: true,
      baseIntervalMs: postsIntervalMs(),
      bounds: boundsForPosts(),
      fetch: async (maxResults) => {
        const sweep = await fetchItems({ subreddits: [community], maxResults });
        if (sweep.failed.length > 0) failed.push(...sweep.failed);
        return sweep.items;
      },
    });

    logSync("posts", market.isRegularSessionOpen, result);
    rowsReceived += result.rowsReceived;
    newItems += result.newItems;
    duplicates += result.duplicates;
    estimatedCostUsd += result.estimatedCostUsd;
    if (result.error) failed.push(community);
  }

  // Nothing new is the NORMAL outcome of a ten-minute poll on a quiet hour, not
  // a failure — and it is the cheap outcome, which is the point.
  const quiet = newItems === 0;
  return {
    ...(quiet ? { status: "success_without_change" as const } : {}),
    communities,
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
