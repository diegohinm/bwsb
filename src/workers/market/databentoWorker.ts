import { env } from "../../config/env.js";
import { increment, observeDuration } from "../../lib/metrics.js";
import type { JobMetadata } from "../../lib/jobRunner.js";
import {
  saveQuotesIfChanged,
  type QuoteSnapshotInput,
} from "../../repositories/marketSnapshots.repository.js";
import {
  getCandles,
  getDelayedQuotesForIngestion,
  getQuotes,
  liveIngestionEnabled,
} from "../../services/market-data/marketData.service.js";
import { saveCandles, toCandleUpsert } from "../../services/market-data/candleCache.service.js";
import {
  claimMarketDataJobs,
  completeMarketDataJobs,
  failMarketDataJobs,
  releaseStuckJobs,
  type MarketDataJobRow,
} from "../../services/market-data/marketDataQueue.service.js";
import { CANDLE_TIMEFRAMES, type CandleTimeframe } from "../../services/market-data/marketData.types.js";
import type { MarketDataDisplayMode, MarketQuote } from "../../services/market-data/marketData.types.js";

/**
 * THE MARKET-DATA WORKER — the only thing in this codebase that causes a
 * Databento request as a result of demand.
 *
 * IT DOES NOT TOUCH REDDIT. No import from services/social, no import from
 * services/discussion, no path from a Reddit item to this file. That separation
 * is the point of the whole refactor: if Databento is offline, this worker logs
 * failures and retries, and every Reddit surface — Discussion, search, Top
 * Tickers, Hot Tickers, sentiment, Daily Discussion — carries on unaware,
 * because none of them reads anything this worker writes.
 *
 * BATCHING IS NOT AN OPTIMIZATION HERE, IT IS THE DESIGN. Twenty queued symbols
 * are twenty rows and ONE upstream request, because the provider interface takes
 * a symbol list (`getQuotes(symbols[])`, `getDelayedBars({symbols})`). Draining
 * the queue one job at a time would multiply cost by twenty for identical data.
 * Candles are the exception and are fetched per symbol: each one has its own
 * interval and its own missing range, so there is nothing to combine.
 */

/** Jobs whose work is "get the current price", and which therefore batch together. */
const QUOTE_LIKE = new Set(["QUOTE", "SNAPSHOT"]);

/** Never publish a real-time label from the worker. */
function safeDisplayMode(mode: MarketDataDisplayMode): MarketDataDisplayMode {
  return mode === "realtime" ? "delayed" : mode;
}

function toSnapshotInput(q: MarketQuote): QuoteSnapshotInput {
  const displayMode = safeDisplayMode(q.displayMode);
  return {
    symbol: q.symbol,
    price: q.price,
    change: q.change ?? null,
    changePct: q.changePct ?? null,
    volume: q.volume ?? null,
    session: q.session,
    provider: q.provider,
    source: q.source,
    displayMode,
    delayMinutes: env.MARKET_DATA_DELAY_MINUTES,
    isMock: q.isMock,
    isDelayed: displayMode !== "realtime",
    observedAt: q.timestamp,
  };
}

/** Split a list into provider-sized requests. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type BatchOutcome = { done: string[]; failed: string[]; error?: string };

/**
 * One upstream request per batch of symbols, however many jobs asked for them.
 *
 * Several jobs can name the SAME symbol — a background sweep and a page view
 * arriving within the dedupe window on different job types. The symbol is
 * requested once and every job waiting on it is resolved from that one answer.
 */
async function runQuoteJobs(jobs: MarketDataJobRow[]): Promise<BatchOutcome> {
  const jobsBySymbol = new Map<string, string[]>();
  for (const job of jobs) {
    const list = jobsBySymbol.get(job.ticker) ?? [];
    list.push(job.id);
    jobsBySymbol.set(job.ticker, list);
  }

  const symbols = [...jobsBySymbol.keys()];
  const done: string[] = [];
  const failed: string[] = [];
  let lastError: string | undefined;

  // The env value is a preference, not a licence: a provider with a smaller
  // per-request symbol cap has to win, or every batch is rejected upstream.
  const batchSize = Math.max(1, Math.min(env.MARKET_DATA_BATCH_SIZE, PROVIDER_SYMBOL_CAP));

  for (const batch of chunk(symbols, batchSize)) {
    const started = Date.now();
    try {
      // Three paths, same as the legacy scheduled job: the delayed historical
      // endpoint by default, the live one only when a real-time feed is both
      // licensed and configured, and the plain service call under the mock
      // provider — which has no delayed-bars endpoint at all and would otherwise
      // fail every batch until the job gave up.
      const quotes =
        liveIngestionEnabled || env.MARKET_DATA_PROVIDER === "mock"
          ? await getQuotes(batch)
          : (await getDelayedQuotesForIngestion(batch)).quotes;

      observeDuration("databento_quote_batch_ms", Date.now() - started);

      // Mock rows are discarded UNLESS mock is the configured provider, in which
      // case they are the intended output and dropping them would leave the
      // cache permanently empty in demo environments. With a real provider they
      // are what the service substitutes after a failure, and persisting those
      // would write invented prices into the snapshot table as if measured.
      const demoMode = env.MARKET_DATA_PROVIDER === "mock";
      const usable = demoMode ? quotes : quotes.filter((q) => !q.isMock);
      if (usable.length > 0) await saveQuotesIfChanged(usable.map(toSnapshotInput));

      // A symbol the provider had nothing for is NOT a failure. Outside market
      // hours there is legitimately no new bar, and retrying a quiet market on a
      // backoff would burn the retry budget that real outages need.
      const returned = new Set(usable.map((q) => q.symbol.toUpperCase()));
      for (const symbol of batch) {
        done.push(...(jobsBySymbol.get(symbol) ?? []));
        if (!returned.has(symbol)) {
          console.log(`[market-worker] no quote returned for ${symbol} (market may be closed)`);
        }
      }
    } catch (err) {
      // THE WHOLE BATCH failed — a provider outage, a bad key, a rate limit. The
      // jobs go back for a retry with backoff; nothing stored is disturbed.
      lastError = err instanceof Error ? err.message : String(err);
      observeDuration("databento_quote_batch_ms", Date.now() - started);
      for (const symbol of batch) failed.push(...(jobsBySymbol.get(symbol) ?? []));
      console.error(`[market-worker] quote batch of ${batch.length} failed: ${lastError}`);
    }
  }

  return { done, failed, ...(lastError ? { error: lastError } : {}) };
}

/**
 * Hard cap on symbols per upstream request.
 *
 * Kept as a code constant next to the worker that has to respect it, the same
 * way the rest of the Databento tuning lives in providers/databento.config.ts
 * rather than the environment. MARKET_DATA_BATCH_SIZE may lower it; nothing may
 * raise it past what the provider accepts.
 */
const PROVIDER_SYMBOL_CAP = 100;

type CandleParams = { interval: CandleTimeframe; from: string; to: string };

/** Read a candle job's request, rejecting anything the provider cannot be asked. */
export function readCandleParams(params: unknown): CandleParams | null {
  if (!params || typeof params !== "object") return null;
  const raw = params as Record<string, unknown>;
  const interval = raw.interval;
  const from = raw.from;
  const to = raw.to;

  if (typeof interval !== "string" || !(CANDLE_TIMEFRAMES as readonly string[]).includes(interval)) {
    return null;
  }
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;

  return { interval: interval as CandleTimeframe, from, to };
}

/**
 * Fill the missing range of a candle series.
 *
 * One request per job: each carries its own symbol, interval and gap, so there
 * is no common request to batch them into. The gap was computed when the job was
 * enqueued — see candleCache.missingCandleRanges — which is what keeps this from
 * re-downloading history that is already stored.
 */
async function runCandleJobs(jobs: MarketDataJobRow[]): Promise<BatchOutcome> {
  const done: string[] = [];
  const failed: string[] = [];
  let lastError: string | undefined;

  for (const job of jobs) {
    const params = readCandleParams(job.params);
    if (!params) {
      // Unusable request. Retrying cannot help, so it is completed rather than
      // retried — the alternative is a poison row claimed forever.
      console.error(`[market-worker] candle job ${job.id} has unusable params; dropping`);
      done.push(job.id);
      continue;
    }

    const started = Date.now();
    try {
      const candles = await getCandles({
        symbol: job.ticker,
        timeframe: params.interval,
        from: params.from,
        to: params.to,
        session: "all",
      });
      observeDuration("databento_candle_request_ms", Date.now() - started);

      // With a real provider configured, mock bars mean the request FAILED and
      // the service substituted them. Persisting those would poison the cache
      // with invented prices that every later read would treat as measured
      // history — and unlike a quote, a candle is never overwritten by a fresher
      // one, so the damage would be permanent. Under the mock provider they are
      // the intended output and are stored.
      const real =
        env.MARKET_DATA_PROVIDER === "mock" ? candles : candles.filter((c) => !c.isMock);
      if (real.length > 0) {
        await saveCandles(real.map((c) => toCandleUpsert(job.ticker, params.interval, c)));
      }
      done.push(job.id);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      observeDuration("databento_candle_request_ms", Date.now() - started);
      failed.push(job.id);
      console.error(`[market-worker] candles for ${job.ticker} failed: ${lastError}`);
    }
  }

  return { done, failed, ...(lastError ? { error: lastError } : {}) };
}

/**
 * Drain one pass of the queue.
 *
 * Returns job metadata rather than throwing on provider failure: a Databento
 * outage is an expected state for this worker, recorded in worker_runs and
 * retried on the next tick, not an incident that should take the process down —
 * and certainly not one that should stop the Reddit jobs sharing the process.
 */
export async function runMarketDataQueue(): Promise<JobMetadata> {
  if (!env.MARKET_DATA_QUEUE_ENABLED) {
    return { status: "skipped", reason: "MARKET_DATA_QUEUE_ENABLED=false" };
  }

  const reclaimed = await releaseStuckJobs();
  const jobs = await claimMarketDataJobs(env.MARKET_QUEUE_BATCH_LIMIT);

  if (jobs.length === 0) {
    return { status: "success_without_change", reclaimed, claimed: 0 };
  }

  const quoteJobs = jobs.filter((j) => QUOTE_LIKE.has(j.jobType));
  const candleJobs = jobs.filter((j) => j.jobType === "CANDLES");

  const idle: BatchOutcome = { done: [], failed: [] };
  const [quotes, candles] = await Promise.all<BatchOutcome>([
    quoteJobs.length > 0 ? runQuoteJobs(quoteJobs) : Promise.resolve(idle),
    candleJobs.length > 0 ? runCandleJobs(candleJobs) : Promise.resolve(idle),
  ]);

  const done = [...quotes.done, ...candles.done];
  const failed = [...quotes.failed, ...candles.failed];
  const error = quotes.error ?? candles.error ?? "provider request failed";

  await completeMarketDataJobs(done);
  const givenUp = await failMarketDataJobs(failed, error);

  const uniqueSymbols = new Set(jobs.map((j) => j.ticker)).size;
  console.log(
    `[market-worker] claimed=${jobs.length} symbols=${uniqueSymbols} ` +
      `quoteJobs=${quoteJobs.length} candleJobs=${candleJobs.length} ` +
      `done=${done.length} retrying=${failed.length - givenUp} gaveUp=${givenUp} reclaimed=${reclaimed}`,
  );

  return {
    ...(failed.length > 0 && done.length === 0 ? { status: "success_without_change" } : {}),
    reclaimed,
    claimed: jobs.length,
    uniqueSymbols,
    quoteJobs: quoteJobs.length,
    candleJobs: candleJobs.length,
    completed: done.length,
    retrying: failed.length - givenUp,
    gaveUp: givenUp,
    batchSize: Math.min(env.MARKET_DATA_BATCH_SIZE, PROVIDER_SYMBOL_CAP),
  };
}

/** Exported for the scheduled sweep; see jobs/enqueueMarketDataJobs.job.ts. */
export { increment as recordMarketMetric };
