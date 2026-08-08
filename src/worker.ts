import { env } from "./config/env.js";
import { BRANDING } from "./config/branding.js";
import { arcticShiftWorkerConfig, redditConfig } from "./config/reddit.config.js";
import {
  describeRedditDataConfig,
  getRedditDataConfig,
} from "./config/redditDataConfig.js";
import { SERVICE_ROLE, isApiRole } from "./config/serviceRole.js";
import { WORKER_NAME } from "./config/ingestion.js";
import { isMainModule, startJobLoop, type JobLoopHandle } from "./lib/jobRunner.js";
import { prisma, registerPrismaShutdown, registerProcessSafetyNet } from "./lib/prisma.js";
import { withDbRetry } from "./lib/dbRetry.js";
import { setTickerAllowlist } from "./services/social/tickerExtractor.service.js";
import { refreshMarketQuotes } from "./jobs/refreshMarketQuotes.job.js";
import { refreshMarketMovers } from "./jobs/refreshMarketMovers.job.js";
import { refreshSocialPulse } from "./jobs/refreshSocialPulse.job.js";
import { refreshTickerStrip } from "./jobs/refreshTickerStrip.job.js";
import { refreshTickerSocialMetrics } from "./jobs/refreshTickerSocialMetrics.job.js";
import { refreshArenaTickerPerformance } from "./jobs/refreshArenaTickerPerformance.job.js";
import { recalculateArenaUserPerformance } from "./jobs/recalculateArenaUserPerformance.job.js";
import { refreshEarningsCalendar } from "./jobs/refreshEarningsCalendar.job.js";
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
/** Holds the event loop open while every job timer is unref'd. */
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
/** The paced Arctic Shift loop, when ARCTIC_SHIFT_ENABLED=true. */
let arcticShiftWorker: ArcticShiftWorkerHandle | undefined;

/**
 * Widen the provisional extractor's allowlist to the real catalog.
 *
 * Without this it only ever knew 24 hard-coded symbols, so anything else was
 * dropped from `SocialPostItem.tickers` before the in-memory aggregators saw it.
 *
 * AWAITED, NOT FIRE-AND-FORGET. The first version launched this as a floating
 * promise beside the schedulers, so a cold start ran the catalog read at the
 * same instant every job opened its first connection — the moment the pooler is
 * least able to serve one. Now it completes (or gives up) before any job is
 * scheduled, and it retries transient failures with backoff instead of losing
 * the allowlist for the lifetime of the process.
 *
 * It is NOT fatal. The authoritative associations are catalog-validated later,
 * against the database, so a worker that boots without the allowlist still
 * ingests correctly — it just falls back to the static symbol list for the
 * provisional in-memory value.
 */
async function primeTickerAllowlist(): Promise<void> {
  try {
    const rows = await withDbRetry(
      () => prisma.tickers.findMany({ where: { isActive: true }, select: { ticker: true } }),
      { label: "primeTickerAllowlist" },
    );
    setTickerAllowlist(rows.map((r) => r.ticker));
    console.log(`[worker] ticker allowlist primed with ${rows.length} symbols`);
  } catch (err) {
    console.error(
      "[worker] could not prime ticker allowlist — continuing with the static list:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * One trivial query before anything is scheduled.
 *
 * Booting a dozen job loops against an unreachable database produces a dozen
 * near-simultaneous failures and a dozen retries; failing this once, slowly,
 * says the same thing far more cheaply. Not fatal either — the worker is
 * supposed to survive a database that comes back.
 */
async function checkDatabaseReachable(): Promise<boolean> {
  try {
    await withDbRetry(() => prisma.$queryRaw`SELECT 1`, { label: "worker boot health check" });
    console.log("[worker] database reachable");
    return true;
  } catch (err) {
    console.error(
      "[worker] database is NOT reachable at boot — schedulers will start anyway and retry:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

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

let schedulersStarted = false;

/**
 * Start every job loop. Idempotent.
 *
 * The guard is not theoretical: a module with a side effect at import time, or
 * an entrypoint loaded twice, would otherwise register a second full set of
 * intervals against the same connection pool — every job running twice as
 * often, each pair racing for the same three connections.
 */
export function startSchedulers(): void {
  if (schedulersStarted) {
    console.warn("[worker] schedulers already started — ignoring duplicate call");
    return;
  }
  schedulersStarted = true;
  // Handles from a previous run are stale once their timers are cleared.
  loops.length = 0;

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
    // Per-ticker social buckets: pure derivation over stored content, so the
    // Popular Tickers sentiment column and the trend chart never touch a
    // provider. Runs after the social ingestion that feeds it.
    startJobLoop({
      name: "refreshTickerSocialMetrics",
      intervalSeconds: env.TICKER_STRIP_REFRESH_SECONDS,
      run: refreshTickerSocialMetrics,
      initialDelayMs: 75_000,
    }),
    // Arena: both jobs derive from stored content and stored delayed quotes, so
    // the public page never costs an upstream request.
    startJobLoop({
      name: "refreshArenaTickerPerformance",
      intervalSeconds: env.ARENA_REFRESH_SECONDS,
      run: refreshArenaTickerPerformance,
      initialDelayMs: 100_000,
    }),
    startJobLoop({
      name: "recalculateArenaUserPerformance",
      intervalSeconds: env.ARENA_REFRESH_SECONDS,
      run: recalculateArenaUserPerformance,
      initialDelayMs: 130_000,
    }),
    // Earnings calendar: the ONE job here that calls an external provider on a
    // slow cadence. Six hours by default — report dates move on the scale of
    // days, so polling faster would spend provider budget for nothing.
    startJobLoop({
      name: "refreshEarningsCalendar",
      intervalSeconds: env.EARNINGS_REFRESH_SECONDS,
      run: refreshEarningsCalendar,
      // Last in the cold-start order: it picks its symbols from the social
      // aggregates the jobs above have just written.
      initialDelayMs: 150_000,
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
    // The catch is required, not stylistic — this promise lives for the whole
    // process, so without one a single rejection deep in the paced loop becomes
    // an unhandled rejection with no indication of where it came from.
    arcticShiftWorker.start().catch((err: unknown) =>
      console.error(
        "[worker] arcticShift loop stopped with an error:",
        err instanceof Error ? err.message : err,
      ),
    );

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

  keepAliveTimer = keepAlive;
}

/**
 * Stop scheduling. Idempotent, and safe to call before `startSchedulers`.
 *
 * Only stops the CLOCK. Work already in flight keeps its connection and is
 * given a grace period by the caller — killing it here would abandon a
 * half-written snapshot.
 */
export function stopSchedulers(): void {
  for (const loop of loops) loop.stop();
  // The handles are DELIBERATELY kept. `activeJobNames()` reads them to decide
  // how long to wait for in-flight work, so emptying the array here would make
  // the grace period believe nothing was running and disconnect the pool out
  // from under a job mid-write.
  arcticShiftWorker?.stop();
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
  schedulersStarted = false;
}

/** True while any scheduled job is mid-execution. */
function activeJobNames(): string[] {
  const names = loops.filter((l) => l.isRunning()).map((l) => l.name);
  if (arcticShiftWorker?.isRunning()) names.push("arcticShiftCycle");
  return names;
}

async function main(): Promise<void> {
  banner();

  // Boot order: configuration, then connectivity, then caches, then signal
  // handlers, and only then the schedulers. Registering the handlers before the
  // loops means a SIGTERM arriving mid-boot is still handled.
  await checkDatabaseReachable();
  await primeTickerAllowlist();

  registerProcessSafetyNet("worker");

  // Stop scheduling, let in-flight jobs finish their writes, then disconnect
  // Prisma (registerPrismaShutdown runs this callback first, so the grace period
  // below still has a live connection pool).
  registerPrismaShutdown("worker", async (signal) => {
    console.log(`[worker] ${signal} received — stopping schedulers…`);
    stopSchedulers();

    // Give in-flight jobs a bounded grace period to finish their DB writes.
    const deadline = Date.now() + 15_000;
    while (activeJobNames().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const stillRunning = activeJobNames();
    if (stillRunning.length > 0) {
      console.warn(`[worker] still running at shutdown: ${stillRunning.join(", ")}`);
    }
  });

  startSchedulers();
  console.log("[worker] ready.");
}

// GUARDED, so importing this module in a test does not boot a second worker —
// the exact class of import side effect that lets two sets of schedulers run
// against one connection pool.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[worker] fatal error during startup:", err);
    process.exitCode = 1;
  });
}
