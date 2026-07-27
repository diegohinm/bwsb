import { env } from "../config/env.js";
import { WORKER_MARKET_SYMBOLS } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import {
  readLatestQuotes,
  saveQuotesIfChanged,
  type QuoteSnapshotInput,
} from "../repositories/marketSnapshots.repository.js";
import {
  getDelayedQuotesForIngestion,
  getQuotes,
  liveIngestionEnabled,
} from "../services/market-data/marketData.service.js";
import { DATABENTO_CONFIG } from "../services/market-data/providers/databento.config.js";
import type { MarketDataDisplayMode, MarketQuote } from "../services/market-data/marketData.types.js";

/**
 * WORKER JOB — market quotes.
 *
 * DELAYED BY DESIGN. With MARKET_DATA_MODE=delayed (the default) this job never
 * touches a live feed: it reads OHLCV-1m bars from the provider's HISTORICAL
 * endpoint with `end = now − MARKET_DATA_DELAY_MINUTES`, so nothing fresher than
 * the published delay is even requested. The live path is used ONLY when a
 * real-time feed is both licensed and explicitly configured
 * (see marketData.service.liveIngestionEnabled).
 *
 * Outcomes, all of them non-failures:
 *   success                  → at least one symbol got a newer bar
 *   success_without_change   → bars found, but every one matches what we stored
 *   skipped_market_closed    → no bar in range and the market is closed
 *
 * It only FAILS when the provider itself is broken/misconfigured. A quiet market
 * must never look like an outage, and previous snapshots are always retained:
 * nothing here deletes rows or overwrites real prices with demo values.
 */

/** True when demo data is the intended state, not a failure. */
function demoModeActive(): boolean {
  return env.MARKET_DATA_PROVIDER === "mock";
}

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

/**
 * Demo/live path: one shot through the market-data service (which labels and
 * mock-falls-back internally). Used when the provider IS mock, or when a
 * real-time feed is explicitly licensed.
 */
async function refreshViaServiceQuotes(symbols: string[]): Promise<JobMetadata> {
  const quotes = await getQuotes(symbols);
  const demoMode = demoModeActive();
  const usable = demoMode ? quotes : quotes.filter((q) => !q.isMock);

  if (usable.length === 0) {
    throw new Error(
      `No quotes available from ${env.MARKET_DATA_PROVIDER} for ${symbols.length} symbol(s); previous snapshots kept.`,
    );
  }

  const { updated, unchanged } = await saveQuotesIfChanged(usable.map(toSnapshotInput));
  return {
    mode: liveIngestionEnabled ? "live" : "demo",
    provider: env.MARKET_DATA_PROVIDER,
    symbolsRequested: symbols.length,
    symbolsUpdated: updated.length,
    symbolsUnchanged: unchanged.length,
    symbolsMissing: symbols.length - usable.length,
    isMock: usable.some((q) => q.isMock),
  };
}

/** The default path: delayed bars from the historical API. */
async function refreshViaDelayedBars(symbols: string[]): Promise<JobMetadata> {
  const ingestion = await getDelayedQuotesForIngestion(symbols);
  const {
    quotes,
    cutoff,
    windowStart,
    windowEnd,
    recordsFetched,
    widened,
    session,
    marketOpen,
    delayMinutes,
    availableEnd,
    barAgeMinutes,
  } = ingestion;

  const base = {
    mode: "delayed" as const,
    provider: env.MARKET_DATA_PROVIDER,
    dataset: DATABENTO_CONFIG.equitiesDataset,
    schema: DATABENTO_CONFIG.equitiesSchema,
    cutoff,
    windowStart,
    windowEnd,
    widened,
    session,
    delayMinutes,
    // The feed's own limit. When it trails the cutoff, IT is what bounds
    // freshness — worth recording so a stale strip is explainable.
    providerDataAvailableUntil: availableEnd,
    barAgeMinutes,
    symbolsRequested: symbols.length,
  };

  if (quotes.length === 0) {
    // No bar in range. Outside market hours this is simply how the world is; the
    // stored snapshots stay exactly as they were.
    const stored = await readLatestQuotes(symbols);
    const message = marketOpen
      ? `No delayed historical bars found in the requested range (${windowStart} → ${windowEnd}).`
      : "Market closed; previous delayed snapshots retained.";
    console.log(`[worker] refreshMarketQuotes: ${message}`);

    if (!marketOpen) {
      return {
        ...base,
        status: "skipped_market_closed",
        message,
        symbolsUpdated: 0,
        symbolsUnchanged: 0,
        symbolsMissing: symbols.length,
        recordsFetched,
        snapshotsRetained: stored.length,
      };
    }

    // Market IS open and still nothing came back. Report it, but only as a hard
    // failure when there is no prior data to serve — otherwise the API keeps
    // answering from the retained snapshots and this is a soft miss.
    if (stored.length === 0) {
      throw new Error(
        `${message} No previous snapshots exist for any of the ${symbols.length} symbol(s).`,
      );
    }
    return {
      ...base,
      status: "success_without_change",
      message,
      symbolsUpdated: 0,
      symbolsUnchanged: 0,
      symbolsMissing: symbols.length,
      recordsFetched,
      snapshotsRetained: stored.length,
    };
  }

  const { updated, unchanged } = await saveQuotesIfChanged(quotes.map(toSnapshotInput));
  const missing = symbols.length - quotes.length;

  console.log(
    `[worker] refreshMarketQuotes: mode=delayed dataset=${base.dataset} schema=${base.schema} ` +
      `cutoff=${cutoff} symbolsRequested=${symbols.length} symbolsUpdated=${updated.length} ` +
      `symbolsUnchanged=${unchanged.length} symbolsMissing=${missing} barAgeMinutes=${barAgeMinutes}` +
      (widened ? " (range widened to the last trading session)" : ""),
  );

  return {
    ...base,
    // Bars exist but none moved — a legitimate quiet-market outcome, not an error.
    ...(updated.length === 0 ? { status: "success_without_change" as const } : {}),
    symbolsUpdated: updated.length,
    symbolsUnchanged: unchanged.length,
    symbolsMissing: missing,
    recordsFetched,
    isMock: false,
  };
}

export async function refreshMarketQuotes(): Promise<JobMetadata> {
  const symbols = [...WORKER_MARKET_SYMBOLS];

  // Live only when it is deliberately licensed AND configured; demo only when
  // the provider itself is mock. Everything else is the delayed historical path.
  if (liveIngestionEnabled || demoModeActive()) {
    return refreshViaServiceQuotes(symbols);
  }
  return refreshViaDelayedBars(symbols);
}

// Manual run: npm run market:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshMarketQuotes", refreshMarketQuotes);
}
