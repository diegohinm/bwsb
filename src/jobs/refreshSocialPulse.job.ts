import { env } from "../config/env.js";
import { WORKER_PULSE_TIMEFRAMES } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import {
  savePulseSnapshot,
  saveSocialItems,
} from "../repositories/socialSnapshots.repository.js";
import { buildSubredditPulse } from "../services/social/pulseAggregator.service.js";
import {
  getSocialDataProvider,
  mockSocialDataProvider,
} from "../services/social/socialDataProvider.factory.js";
import { redditConfig } from "../config/reddit.config.js";
import type { SocialItemsResult } from "../services/social/socialData.provider.js";
import type { PulseTimeframe } from "../services/social/socialData.types.js";

/**
 * WORKER JOB — Reddit/social ingestion.
 *
 * Pulls normalized posts/comments from the configured social provider
 * (Mindcase), stores them in `social_posts` / `social_comments`, then computes
 * and stores per-subreddit pulse metrics in `subreddit_pulse_snapshots` for
 * every timeframe. The API reads those tables — it never calls Mindcase.
 *
 * Rate-limit safety lives in the provider itself (bounded concurrency, spaced
 * job polling, Retry-After aware 429 backoff — see
 * services/social/providers/mindcaseSocialData.provider.ts). This job adds the
 * ingestion-level guarantees:
 *   - one subreddit failing never fails the run; partial results are saved;
 *   - a run that returned nothing at all is logged as an error and leaves the
 *     previous snapshots untouched, so the API keeps serving last-known-good.
 */

/** True when demo data is the intended state rather than a failure. */
function demoModeActive(): boolean {
  return env.SOCIAL_DATA_PROVIDER === "mock" || (env.SOCIAL_DATA_PROVIDER as string) === "off";
}

export async function refreshSocialPulse(): Promise<JobMetadata> {
  const provider = demoModeActive() ? mockSocialDataProvider : getSocialDataProvider();
  // REDDIT_SUBREDDITS drives every provider, this one included.
  const subreddits = [...redditConfig.subreddits];

  if (typeof provider.fetchItems !== "function") {
    throw new Error(
      `Social provider "${provider.name}" cannot expose raw items for ingestion.`,
    );
  }

  let sweep: SocialItemsResult;
  try {
    sweep = await provider.fetchItems({ subreddits });
  } catch (err) {
    // A total provider failure (all subreddits rate-limited, misconfigured, …).
    // Previous snapshots stay in place; the run is recorded as an error.
    throw new Error(
      `Social fetch failed for ${provider.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (sweep.items.length === 0) {
    throw new Error(
      `Social fetch returned no items (failed subreddits: ${sweep.failed.join(", ") || "none"}); previous snapshots kept.`,
    );
  }

  // 1. Persist the raw normalized items (idempotent on the provider's own id).
  const stored = await saveSocialItems(sweep.items);

  // 2. Compute + store the aggregated pulse for every timeframe.
  const snapshotAt = new Date().toISOString();
  const isMock = provider.name === "mock";
  const warning =
    sweep.failed.length > 0
      ? `Partial data: ${sweep.failed.length} of ${sweep.attempted} subreddits unavailable${
          sweep.rateLimited ? " (provider rate limit)" : ""
        }.`
      : null;

  const perTimeframe: Record<string, number> = {};
  for (const timeframe of WORKER_PULSE_TIMEFRAMES as readonly PulseTimeframe[]) {
    const aggregate = buildSubredditPulse(sweep.items, timeframe);
    perTimeframe[timeframe] = await savePulseSnapshot(
      {
        timeframe,
        provider: provider.name,
        source: provider.name,
        isMock,
        warning,
        subreddits: aggregate.subreddits,
      },
      snapshotAt,
    );
  }

  return {
    provider: provider.name,
    snapshotAt,
    itemsFetched: sweep.items.length,
    postsStored: stored.posts,
    commentsStored: stored.comments,
    subredditsAttempted: sweep.attempted,
    subredditsFailed: sweep.failed,
    rateLimited: sweep.rateLimited,
    pulseRowsPerTimeframe: perTimeframe,
    isMock,
  };
}

// Manual run: npm run social:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshSocialPulse", refreshSocialPulse);
}
