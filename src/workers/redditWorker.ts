import {
  describeRedditDataConfig,
  getRedditDataConfig,
} from "../config/redditDataConfig.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { getRedditDataProvider } from "../providers/reddit/RedditProviderFactory.js";
import { ingestRedditPosts } from "../services/redditIngestionService.js";

/**
 * WORKER JOB — Reddit ingestion through the configurable provider layer.
 *
 * THE ONLY PLACE THAT CALLS A REDDIT PROVIDER. The API process reads
 * PostgreSQL; users never trigger an upstream call. Even if a route tried, the
 * SERVICE_ROLE guard in config/serviceRole.ts blocks it.
 *
 * Registered on an interval by src/worker.ts, and runnable on its own with
 * `npm run reddit:ingest` for a manual backfill.
 *
 * A run that stores nothing is reported as `success_without_change` rather than
 * as an error: when both providers are down the correct behaviour is to leave
 * the previous data in place and let the dashboard keep serving it.
 */
export async function runRedditIngestion(): Promise<JobMetadata> {
  const config = getRedditDataConfig();
  const provider = getRedditDataProvider();

  console.log(
    `[RedditProvider] ${describeRedditDataConfig(config)} available=${provider.isAvailable()}`,
  );

  const summary = await ingestRedditPosts({
    includeComments: redditIngestCommentsEnabled(),
  });

  const stored =
    summary.posts.created +
    summary.posts.updated +
    summary.comments.created +
    summary.comments.updated;

  // Every subreddit failed AND nothing was written: a real outage, worth an
  // error row so /api/ingestion/status shows it.
  if (stored === 0 && summary.subredditsFailed.length === summary.subredditsAttempted) {
    throw new Error(
      `Reddit ingestion failed for all ${summary.subredditsAttempted} subreddit(s) ` +
        `(mode=${summary.mode}); previous data kept.`,
    );
  }

  return {
    ...(stored === 0 ? { status: "success_without_change" } : {}),
    mode: summary.mode,
    provider: summary.provider,
    subredditsAttempted: summary.subredditsAttempted,
    subredditsFailed: summary.subredditsFailed,
    postsFetched: summary.postsFetched,
    postsCreated: summary.posts.created,
    postsUpdated: summary.posts.updated,
    postsFailed: summary.posts.failed,
    commentsFetched: summary.commentsFetched,
    commentsCreated: summary.comments.created,
    commentsUpdated: summary.comments.updated,
    tickersDetected: summary.tickersDetected,
  };
}

/**
 * REDDIT_INGEST_COMMENTS — off by default.
 *
 * Comments cost one provider call PER POST, so enabling this multiplies quota
 * consumption. Read here rather than in the config module because it tunes the
 * job, not the provider wiring.
 */
function redditIngestCommentsEnabled(): boolean {
  return process.env.REDDIT_INGEST_COMMENTS?.trim().toLowerCase() === "true";
}

// Manual run: npm run reddit:ingest
if (isMainModule(import.meta.url)) {
  void runJobAsScript("runRedditIngestion", runRedditIngestion);
}
