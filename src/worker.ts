import { env } from "./config/env.js";
import { BRANDING } from "./config/branding.js";
import { arcticShiftWorkerConfig, redditConfig } from "./config/reddit.config.js";
import {
  describeRedditDataConfig,
  getRedditDataConfig,
} from "./config/redditDataConfig.js";
import { SERVICE_ROLE, isApiRole } from "./config/serviceRole.js";
import { WORKER_NAME } from "./config/ingestion.js";
import { startJobLoop, type JobLoopHandle } from "./lib/jobRunner.js";
import { registerPrismaShutdown } from "./lib/prisma.js";
import { refreshMarketQuotes } from "./jobs/refreshMarketQuotes.job.js";
import { refreshMarketMovers } from "./jobs/refreshMarketMovers.job.js";
import { refreshSocialPulse } from "./jobs/refreshSocialPulse.job.js";
import { refreshTickerStrip } from "./jobs/refreshTickerStrip.job.js";
import { refreshWsbPortfolio } from "./jobs/refreshWsbPortfolio.job.js";
import { refreshWsbBanbets } from "./jobs/refreshWsbBanbets.job.js";
import { runRedditIngestion } from "./workers/redditWorker.js";
import { buildArcticShiftWorker } from "./workers/reddit/startArcticShiftWorker.js";
import type { ArcticShiftWorkerHandle } from "./workers/reddit/arcticShiftWorker.js";

/**
 * YOLOPulse INGESTION WORKER (bwsb-worker).
 *
 * The second of the two processes this repo deploys:
 *
 *   bwsb-api    (npm start)  Express. Reads DB snapshots. Calls no provider.
 *   bwsb-worker (npm run worker)  THIS. Calls Mindcase/Databento on a schedule,
 *                                 normalizes, aggregates, writes to Postgres.
 *
 * It exposes no HTTP surface: nothing here listens on a port. Provider API keys
 * belong to this service only.
 *
 * Reliability contract:
 *   - each job runs on its own interval and is skipped (not queued) if the
 *     previous run is still in flight;
 *   - every execution writes a worker_runs row — success or failure;
 *   - a failing job is logged and retried on its next tick; it never takes the
 *     process down;
 *   - SIGTERM/SIGINT stop scheduling, wait briefly for in-flight work, then
 *     disconnect Prisma.
 */

const loops: JobLoopHandle[] = [];
/** The paced Arctic Shift loop, when ARCTIC_SHIFT_ENABLED=true. */
let arcticShiftWorker: ArcticShiftWorkerHandle | undefined;

function banner(): void {
  console.log(
    `${BRANDING.productName} ingestion worker (${WORKER_NAME}) starting — role=${SERVICE_ROLE}, env=${env.NODE_ENV}`,
  );
  console.log(
    `[worker] social=${env.SOCIAL_DATA_PROVIDER} every ${env.SOCIAL_DATA_REFRESH_SECONDS}s · ` +
      `market=${env.MARKET_DATA_PROVIDER} (mode=${env.MARKET_DATA_MODE}, delay ${env.MARKET_DATA_DELAY_MINUTES}m) every ${env.MARKET_DATA_REFRESH_SECONDS}s`,
  );

  // Reddit providers: report the configured mode, or why the job is off. A bad
  // configuration is logged here rather than thrown, so one invalid variable
  // cannot stop the market/social jobs from running.
  if (env.REDDIT_INGESTION_ENABLED) {
    try {
      console.log(
        `[worker] reddit=${describeRedditDataConfig(getRedditDataConfig())} every ${env.REDDIT_INGESTION_REFRESH_SECONDS}s`,
      );
    } catch (err) {
      console.error(
        `[worker] ⚠ ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (isApiRole) {
    // Not fatal: a misconfigured role should be loud, not silently useless.
    console.warn(
      "[worker] ⚠ SERVICE_ROLE=api on the worker process — provider calls are blocked by the role guard. " +
        "Set SERVICE_ROLE=worker on this service.",
    );
  }
  if (env.SOCIAL_DATA_PROVIDER === "mindcase" && !env.MINDCASE_API_KEY) {
    console.warn("[worker] ⚠ SOCIAL_DATA_PROVIDER=mindcase but MINDCASE_API_KEY is not set.");
  }
  if (env.MARKET_DATA_PROVIDER === "databento" && !env.DATABENTO_API_KEY) {
    console.warn("[worker] ⚠ MARKET_DATA_PROVIDER=databento but DATABENTO_API_KEY is not set.");
  }
}

/**
 * How often one community is revisited: cycle interval × number of communities.
 * Five subreddits on a five-minute cycle → each one every 25 minutes.
 */
function estimatedMinutesPerSubreddit(): number {
  return Math.round(
    (redditConfig.subreddits.length * redditConfig.pollIntervalMs) / 60_000,
  );
}

function start(): void {
  banner();

  // Staggered first runs so a cold start does not hit both providers at once,
  // and so the strip job runs after the social/market data it depends on.
  loops.push(
    startJobLoop({
      name: "refreshMarketQuotes",
      intervalSeconds: env.MARKET_DATA_REFRESH_SECONDS,
      run: refreshMarketQuotes,
      initialDelayMs: 0,
    }),
    startJobLoop({
      name: "refreshMarketMovers",
      intervalSeconds: env.MARKET_MOVERS_REFRESH_SECONDS,
      run: refreshMarketMovers,
      initialDelayMs: 5_000,
    }),
    startJobLoop({
      name: "refreshSocialPulse",
      intervalSeconds: env.SOCIAL_DATA_REFRESH_SECONDS,
      run: refreshSocialPulse,
      initialDelayMs: 10_000,
    }),
    startJobLoop({
      name: "refreshTickerStrip",
      intervalSeconds: env.TICKER_STRIP_REFRESH_SECONDS,
      run: refreshTickerStrip,
      // Runs on DB data only — give the first social/market runs a head start.
      initialDelayMs: 60_000,
    }),
    // The two WSB jobs derive from stored content and stored quotes — no
    // provider call, so their interval is a CPU/DB choice, not a rate-limit one.
    // They run last in the cold-start order because they consume what the
    // social and market jobs above have just written.
    startJobLoop({
      name: "refreshWsbPortfolio",
      intervalSeconds: env.WSB_REFRESH_SECONDS,
      run: refreshWsbPortfolio,
      initialDelayMs: 90_000,
    }),
    startJobLoop({
      name: "refreshWsbBanbets",
      intervalSeconds: env.WSB_REFRESH_SECONDS,
      run: refreshWsbBanbets,
      initialDelayMs: 120_000,
    }),
  );

  // Arctic Shift: its own paced loop, NOT a job on an interval.
  //
  // It owns the global budget of one request every five minutes, so it cannot
  // share the generic scheduler with the multi-subreddit ingestion job — the
  // two together would multiply requests by the number of communities. When it
  // is on, it REPLACES that job as the Reddit path.
  if (arcticShiftWorkerConfig.enabled) {
    arcticShiftWorker = buildArcticShiftWorker();
    console.log(
      `[worker] arctic_shift paced loop: 1 request / ${redditConfig.pollIntervalMs / 1000}s across ` +
        `${redditConfig.subreddits.length} subreddit(s) — ` +
        `~${estimatedMinutesPerSubreddit()} min per subreddit`,
    );
    // Fire-and-forget: the loop awaits its own pacing and stops on shutdown.
    void arcticShiftWorker.start();

    if (env.REDDIT_INGESTION_ENABLED) {
      console.warn(
        "[worker] ⚠ REDDIT_INGESTION_ENABLED=true is IGNORED while ARCTIC_SHIFT_ENABLED=true: " +
          "the paced Arctic Shift loop is the Reddit ingestion path, and running both would " +
          "break the one-request-per-five-minutes guarantee.",
      );
    }
  } else if (env.REDDIT_INGESTION_ENABLED) {
    loops.push(
      startJobLoop({
        name: "runRedditIngestion",
        intervalSeconds: env.REDDIT_INGESTION_REFRESH_SECONDS,
        run: runRedditIngestion,
        // Last of the staggered starts: it is the heaviest provider job.
        initialDelayMs: 20_000,
      }),
    );
  } else {
    console.log(
      "[worker] Reddit ingestion is disabled (set REDDIT_INGESTION_ENABLED=true to schedule it).",
    );
  }

  // Keep the process alive even when every timer is unref'd.
  const keepAlive = setInterval(() => {}, 1 << 30);

  // Stop scheduling, let in-flight jobs finish their writes, then disconnect
  // Prisma (registerPrismaShutdown runs this callback first, so the grace period
  // below still has a live connection pool).
  registerPrismaShutdown("worker", async (signal) => {
    console.log(`[worker] ${signal} received — stopping schedulers…`);
    for (const loop of loops) loop.stop();
    // Stops SCHEDULING; the request in flight is allowed to finish its write.
    arcticShiftWorker?.stop();
    clearInterval(keepAlive);

    // Give in-flight jobs a bounded grace period to finish their DB writes.
    const deadline = Date.now() + 15_000;
    while (
      (loops.some((l) => l.isRunning()) || arcticShiftWorker?.isRunning()) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const stillRunning = loops.filter((l) => l.isRunning()).map((l) => l.name);
    if (arcticShiftWorker?.isRunning()) stillRunning.push("arcticShiftCycle");
    if (stillRunning.length > 0) {
      console.warn(`[worker] still running at shutdown: ${stillRunning.join(", ")}`);
    }
  });

  // A stray rejection must never kill the worker — log it and keep scheduling.
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[worker] unhandled rejection:",
      reason instanceof Error ? reason.message : reason,
    );
  });
  process.on("uncaughtException", (err) => {
    console.error("[worker] uncaught exception:", err instanceof Error ? err.message : err);
  });
}

start();
