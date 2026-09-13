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
import { enqueueMarketDataWork } from "./jobs/enqueueMarketDataJobs.job.js";
import { runMarketDataQueue } from "./workers/market/databentoWorker.js";
import { refreshMarketMovers } from "./jobs/refreshMarketMovers.job.js";
import { refreshSocialPulse } from "./jobs/refreshSocialPulse.job.js";
import { describeRedditIngestion, syncRedditPosts } from "./jobs/syncRedditPosts.job.js";
import {
  CONFIG_REFRESH_MS,
  refreshRedditRuntimeConfig,
} from "./services/reddit/redditRuntimeConfig.js";
import { syncRedditComments } from "./jobs/syncRedditComments.job.js";
import { refreshTickerStrip } from "./jobs/refreshTickerStrip.job.js";
import { refreshTickerSocialMetrics } from "./jobs/refreshTickerSocialMetrics.job.js";
import { refreshArenaTickerPerformance } from "./jobs/refreshArenaTickerPerformance.job.js";
import { recalculateArenaUserPerformance } from "./jobs/recalculateArenaUserPerformance.job.js";
import { refreshEarningsCalendar } from "./jobs/refreshEarningsCalendar.job.js";
import { refreshWsbPortfolio } from "./jobs/refreshWsbPortfolio.job.js";
import { refreshWsbBanbets } from "./jobs/refreshWsbBanbets.job.js";
import { refreshTickerCatalog } from "./jobs/refreshTickerCatalog.job.js";
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
  // THE COST-RELEVANT LINE. Printed once per boot so that, after any surprise on
  // the invoice, the log says exactly what this process believed it was allowed
  // to spend and on which communities. Seeing it TWICE in one startup means the
  // scheduler was registered twice and the bill is doubled.
  console.log(describeRedditIngestion());

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
  // SCOPE BEFORE SCHEDULE. The worker has no community variable of its own; it
  // asks the backend which communities are active and refreshes that answer
  // every few minutes. A failure here does NOT stop the worker — the market and
  // analytics jobs are unaffected — it stops REDDIT INGESTION, because a worker
  // that cannot verify its scope must not spend money guessing at it.
  // Not awaited: the load is a network call to another service, and blocking
  // the whole scheduler on it would let a slow backend delay the market and
  // analytics jobs, which have nothing to do with Reddit scope. The Reddit jobs
  // are staggered behind it and refuse to run until it has succeeded, so the
  // ordering is enforced by the guard rather than by the await.
  void refreshRedditRuntimeConfig();
  const configTimer = setInterval(() => void refreshRedditRuntimeConfig(), CONFIG_REFRESH_MS);
  configTimer.unref?.();

  loops.push(
    startJobLoop({
      name: "refreshMarketQuotes",
      intervalSeconds: env.MARKET_DATA_REFRESH_SECONDS,
      run: refreshMarketQuotes,
      initialDelayMs: 0,
    }),
    // THE MARKET-DATA PIPELINE, in two halves that never touch Reddit.
    //
    //   enqueueMarketDataJobs  reads ticker_activity + watchlists/positions and
    //                          writes job rows. No provider call.
    //   marketDataQueue        drains those rows, batches the symbols, and is
    //                          the only scheduled thing that reaches Databento
    //                          on demand.
    //
    // Deliberately split: the decision about WHAT is worth fetching is cheap,
    // database-only and safe to run often, while the FETCH is metered and
    // fails whenever the provider does. Neither one can stall the Reddit jobs
    // in this same process — a job loop that throws is logged and retried on
    // its next tick, never propagated.
    startJobLoop({
      name: "enqueueMarketDataJobs",
      intervalSeconds: env.MARKET_DATA_REFRESH_SECONDS,
      run: enqueueMarketDataWork,
      // After the first quote refresh, so a cold start does not queue work for
      // symbols the legacy job is about to fetch anyway.
      initialDelayMs: 30_000,
    }),
    startJobLoop({
      name: "marketDataQueue",
      intervalSeconds: env.MARKET_QUEUE_POLL_SECONDS,
      run: runMarketDataQueue,
      initialDelayMs: 45_000,
    }),
    startJobLoop({
      name: "refreshMarketMovers",
      intervalSeconds: env.MARKET_MOVERS_REFRESH_SECONDS,
      run: refreshMarketMovers,
      initialDelayMs: 5_000,
    }),
    // ── THE REDDIT INGESTION PAIR ────────────────────────────────────────────
    //
    // These two are the ONLY scheduled things that collect Reddit data, and the
    // only ones that COULD spend money on it. Which upstream they actually use
    // is not decided here and is not decided by them: each asks the source
    // router, which serves the free archive while it is healthy and reaches the
    // metered provider only after repeated failures or excessive archive lag.
    //
    // That indirection is the fix for a specific bug. These jobs used to
    // resolve their own provider from the social-data factory, so the free
    // archive could be configured as the Reddit source while every scheduled
    // run still went to the metered client — two settings, both readable as
    // authoritative, and the expensive one winning silently.
    //
    // Registered ONCE, here. A second registration would silently double the
    // request rate, which is why the startup banner prints the routing policy:
    // two identical lines in one boot is the symptom.
    startJobLoop({
      name: "syncRedditPosts",
      intervalSeconds: env.REDDIT_POSTS_INTERVAL_MINUTES * 60,
      run: syncRedditPosts,
      initialDelayMs: 15_000,
    }),
    // TICKS EVERY MINUTE; SPENDS FAR LESS OFTEN. The cadence is not enforced by
    // this interval but by each thread's persisted `next_sync_at`: when the
    // market is closed a sync sets it ten minutes out, so the intervening ticks
    // find nothing due and make ZERO provider requests. Keeping the timer at one
    // minute means the market opening is picked up within a minute instead of
    // needing a second scheduler — and because the gate lives in the database
    // rather than in memory, a restart does not reset it.
    startJobLoop({
      name: "syncRedditComments",
      intervalSeconds: 60,
      run: syncRedditComments,
      initialDelayMs: 45_000,
    }),
    // Pulse aggregation is now a pure database job — see refreshSocialPulse.
    // It calls no provider, so its interval is a freshness choice, not a cost.
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

  // Ticker catalog: one public text file a day. Scheduled through the same
  // loop as everything else, so it inherits the overlap guard — a slow refresh
  // is skipped rather than started twice — and writes a worker_runs row.
  if (env.TICKER_CATALOG_ENABLED) {
    loops.push(
      startJobLoop({
        name: "refreshTickerCatalog",
        intervalSeconds: Math.round(env.TICKER_CATALOG_REFRESH_INTERVAL_MS / 1000),
        run: refreshTickerCatalog,
        // Last of the staggered starts: the catalog changes daily, so nothing
        // is lost by letting the market and social jobs claim the pool first.
        initialDelayMs: 30_000,
      }),
    );
  } else {
    console.log(
      "[worker] ticker catalog refresh is disabled (set TICKER_CATALOG_ENABLED=true to schedule it).",
    );
  }

  // The paced Arctic Shift loop — SUPERSEDED, and off by default.
  //
  // It predates the source router and solves the same problem a different way:
  // a round-robin across every TRACKED subreddit at one request per five
  // minutes, writing posts only, into `reddit_posts` — a table no product
  // surface reads. It never wrote comments at all.
  //
  // It is now redundant AND actively harmful if left on: the sync jobs above
  // already collect the active community from the same archive, incrementally
  // and into the tables the product actually reads, so running both means two
  // independent things fetching the same subreddit on different schedules —
  // the double ingestion this migration exists to remove.
  //
  // Kept behind its flag rather than deleted because it is still the only way
  // to run a paced multi-subreddit backfill, which is a real (manual) need.
  if (arcticShiftWorkerConfig.enabled) {
    console.warn(
      "[worker] ⚠ ARCTIC_SHIFT_ENABLED=true starts the LEGACY paced loop IN ADDITION to the " +
        "scheduled Reddit sync jobs. Both fetch the same community from the same archive. " +
        "Set ARCTIC_SHIFT_ENABLED=false unless you are deliberately running a backfill.",
    );
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
          "the legacy provider-layer ingestion and the paced loop would both fetch the same " +
          "subreddits, and neither writes the tables the product reads.",
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
