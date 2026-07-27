import { env } from "./config/env.js";
import { BRANDING } from "./config/branding.js";
import { SERVICE_ROLE, isApiRole } from "./config/serviceRole.js";
import { WORKER_NAME } from "./config/ingestion.js";
import { startJobLoop, type JobLoopHandle } from "./lib/jobRunner.js";
import { registerPrismaShutdown } from "./lib/prisma.js";
import { refreshMarketQuotes } from "./jobs/refreshMarketQuotes.job.js";
import { refreshMarketMovers } from "./jobs/refreshMarketMovers.job.js";
import { refreshSocialPulse } from "./jobs/refreshSocialPulse.job.js";
import { refreshTickerStrip } from "./jobs/refreshTickerStrip.job.js";

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

function banner(): void {
  console.log(
    `${BRANDING.productName} ingestion worker (${WORKER_NAME}) starting — role=${SERVICE_ROLE}, env=${env.NODE_ENV}`,
  );
  console.log(
    `[worker] social=${env.SOCIAL_DATA_PROVIDER} every ${env.SOCIAL_DATA_REFRESH_SECONDS}s · ` +
      `market=${env.MARKET_DATA_PROVIDER} (mode=${env.MARKET_DATA_MODE}, delay ${env.MARKET_DATA_DELAY_MINUTES}m) every ${env.MARKET_DATA_REFRESH_SECONDS}s`,
  );

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
  );

  // Keep the process alive even when every timer is unref'd.
  const keepAlive = setInterval(() => {}, 1 << 30);

  // Stop scheduling, let in-flight jobs finish their writes, then disconnect
  // Prisma (registerPrismaShutdown runs this callback first, so the grace period
  // below still has a live connection pool).
  registerPrismaShutdown("worker", async (signal) => {
    console.log(`[worker] ${signal} received — stopping schedulers…`);
    for (const loop of loops) loop.stop();
    clearInterval(keepAlive);

    // Give in-flight jobs a bounded grace period to finish their DB writes.
    const deadline = Date.now() + 15_000;
    while (loops.some((l) => l.isRunning()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const stillRunning = loops.filter((l) => l.isRunning()).map((l) => l.name);
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
