import { arcticShiftWorkerConfig } from "../config/reddit.config.js";
import {
  describeRedditDataConfig,
  getRedditDataConfig,
} from "../config/redditDataConfig.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { disconnectPrisma } from "../lib/prisma.js";
import { getRedditDataProvider } from "../providers/reddit/RedditProviderFactory.js";
import { ingestRedditPosts } from "../services/redditIngestionService.js";
import { buildArcticShiftWorker } from "./reddit/startArcticShiftWorker.js";
import { isEventPublishingConfigured } from "../services/realtime/internalEventPublisher.js";

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

/**
 * Standalone Arctic Shift worker: `npm run dev:worker:reddit`.
 *
 * Runs the paced loop until SIGINT/SIGTERM. On a signal it stops SCHEDULING,
 * lets the request already in flight finish its write, then closes Prisma —
 * killing a cycle mid-persist is exactly how a cursor and the stored posts
 * would drift apart.
 *
 * `--once` runs a single cycle instead (still rate-guarded), and `--ingest`
 * runs the legacy multi-subreddit ingestion used by `npm run reddit:ingest`.
 */
async function runStandaloneArcticShiftWorker(): Promise<never> {
  // A single unambiguous first line: on a hosting platform the log IS the only
  // window into a service with no URL.
  console.log(
    `[RedditWorker] Started — provider=${describeRedditDataConfig(getRedditDataConfig())}, ` +
      `realtime=${isEventPublishingConfigured() ? "on" : "off"}`,
  );

  const worker = buildArcticShiftWorker();
  const runOnce = process.argv.includes("--once");

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `[ArcticShiftWorker] ${signal} received — no new cycles will start; ` +
        `${worker.isRunning() ? "waiting for the in-flight request" : "nothing in flight"}.`,
    );
    worker.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    if (runOnce) {
      await worker.runOnce();
    } else {
      await worker.start();
      // `start()` only resolves once the loop has stopped, which means the
      // signal handler ran AND the last cycle finished.
      while (worker.isRunning()) await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await disconnectPrisma();
  }

  console.log("[ArcticShiftWorker] Stopped cleanly.");
  console.log("[RedditWorker] Stopped.");
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--ingest")) {
    // Legacy one-shot backfill across every subreddit: npm run reddit:ingest
    void runJobAsScript("runRedditIngestion", runRedditIngestion);
  } else if (!arcticShiftWorkerConfig.enabled) {
    console.error(
      "[ArcticShiftWorker] ARCTIC_SHIFT_ENABLED is not true — refusing to start. " +
        "Set ARCTIC_SHIFT_ENABLED=true to run the paced worker, or use --ingest for a one-shot backfill.",
    );
    process.exit(1);
  } else {
    void runStandaloneArcticShiftWorker();
  }
}
