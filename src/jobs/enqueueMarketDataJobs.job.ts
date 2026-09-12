import { env } from "../config/env.js";
import { WORKER_MARKET_SYMBOLS } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import {
  enqueueMarketDataJobs,
  MARKET_PRIORITY,
  queueDepth,
  type EnqueueInput,
} from "../services/market-data/marketDataQueue.service.js";
import { resolveMarketPriorities } from "../services/market-data/marketPriority.service.js";

/**
 * WORKER JOB — decide what market data is worth fetching, and say so.
 *
 * THIS IS THE ONLY PLACE REDDIT INFLUENCES DATABENTO, and it does so at arm's
 * length: it reads `ticker_activity`, which was written hours or minutes ago by
 * a completely separate pipeline, and writes job rows. It never touches a Reddit
 * table on the write side and no Reddit path waits on it. The forbidden coupling
 *
 *     reddit item → ticker detected → Databento → save
 *
 * has no representation here; the implemented one is
 *
 *     (already stored) DB → queue → Databento → DB
 *
 * and the arrow between them is a scheduled job, not a function call.
 *
 * IT ENQUEUES, IT DOES NOT FETCH. Deduplication in the queue means running this
 * every minute and running it every hour differ in latency, not in provider
 * spend: a symbol with a pending job does not gain a second one.
 */

/**
 * The old hardcoded list, kept as a FLOOR rather than deleted.
 *
 * SPY and QQQ are on the dashboard whether or not Reddit mentioned them today,
 * and a quiet weekend must not leave the index panels with nothing. They are
 * enqueued at background priority so they never displace a symbol someone is
 * actually looking at.
 */
function baselineSymbols(): EnqueueInput[] {
  return WORKER_MARKET_SYMBOLS.map((ticker) => ({
    ticker,
    jobType: "QUOTE" as const,
    priority: MARKET_PRIORITY.BACKGROUND,
  }));
}

export async function enqueueMarketDataWork(): Promise<JobMetadata> {
  if (!env.MARKET_DATA_QUEUE_ENABLED) {
    return { status: "skipped", reason: "MARKET_DATA_QUEUE_ENABLED=false" };
  }

  const prioritized = await resolveMarketPriorities();

  const requests: EnqueueInput[] = [
    ...prioritized.map((p) => ({
      ticker: p.ticker,
      jobType: "QUOTE" as const,
      priority: p.priority,
    })),
    ...baselineSymbols(),
  ];

  const enqueued = await enqueueMarketDataJobs(requests);
  const depth = await queueDepth();

  const byPriority = prioritized.reduce<Record<number, number>>((acc, p) => {
    acc[p.priority] = (acc[p.priority] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `[worker] enqueueMarketDataJobs: candidates=${requests.length} enqueued=${enqueued} ` +
      `(deduplicated=${requests.length - enqueued}) pending=${depth.pending} processing=${depth.processing}`,
  );

  return {
    // Nothing new to enqueue is the STEADY STATE, not a problem: it means the
    // queue already knows about every symbol demand has identified.
    ...(enqueued === 0 ? { status: "success_without_change" as const } : {}),
    candidates: requests.length,
    enqueued,
    deduplicated: requests.length - enqueued,
    realtime: byPriority[MARKET_PRIORITY.REALTIME] ?? 0,
    trending: byPriority[MARKET_PRIORITY.TRENDING] ?? 0,
    active: byPriority[MARKET_PRIORITY.ACTIVE] ?? 0,
    baseline: WORKER_MARKET_SYMBOLS.length,
    queuePending: depth.pending,
    queueProcessing: depth.processing,
    queueFailed: depth.failed,
  };
}

if (isMainModule(import.meta.url)) {
  await runJobAsScript("enqueueMarketDataJobs", enqueueMarketDataWork);
}
