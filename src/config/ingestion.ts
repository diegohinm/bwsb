import type { MarketSession } from "../services/market-data/marketData.types.js";

/**
 * What the ingestion worker fetches. Kept out of the jobs themselves so the
 * coverage of the worker is visible in one place.
 *
 * NOTE: this list drives the QUOTE cache only. The dashboard ticker strip is
 * driven by what Reddit actually talks about (trending_ticker_snapshots), never
 * by a hardcoded symbol list — see jobs/refreshTickerStrip.job.ts.
 */
export const WORKER_MARKET_SYMBOLS: readonly string[] = [
  "SPY",
  "QQQ",
  "NVDA",
  "TSLA",
  "RDDT",
  "GME",
  "AMC",
  "HOOD",
  "PLTR",
  "AMD",
  "MSFT",
  "AAPL",
  "META",
  "AMZN",
  "NFLX",
  "POET",
];

/** Sessions the movers job snapshots on every run. */
export const WORKER_MOVER_SESSIONS: readonly MarketSession[] = [
  "regular",
  "premarket",
  "after_hours",
  "overnight",
];

/** Timeframes the worker precomputes pulse + trending snapshots for. */
export const WORKER_PULSE_TIMEFRAMES = ["1h", "6h", "24h", "7d"] as const;

/** Name reported in worker_runs.worker_name. */
export const WORKER_NAME = "bwsb-worker";
