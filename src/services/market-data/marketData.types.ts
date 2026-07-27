/**
 * Shared contract for market data (equities, extended-hours, options).
 *
 * LEGAL SAFETY: every response carries provider / source / displayMode / isMock
 * / isDelayed / timestamp so the UI can NEVER silently show mock as real or
 * delayed as real-time. Real-time, overnight and options-real-time display are
 * gated by explicit env license flags (see marketData.service).
 *
 * Provider keys are read only in the backend and never leave it.
 */

export type MarketDataProviderName =
  | "mock"
  | "databento"
  | "polygon"
  | "alpaca"
  | "twelvedata";

export type MarketSession =
  | "premarket"
  | "regular"
  | "after_hours"
  | "overnight"
  | "closed";

export type MarketDataDisplayMode = "mock" | "delayed" | "realtime" | "end_of_day";

export type AssetType = "equity" | "etf" | "option" | "crypto" | "index" | "unknown";

export const CANDLE_TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"] as const;
export type CandleTimeframe = (typeof CANDLE_TIMEFRAMES)[number];

export const MARKET_SESSIONS: MarketSession[] = [
  "premarket",
  "regular",
  "after_hours",
  "overnight",
  "closed",
];

export interface MarketDataProviderStatus {
  provider: MarketDataProviderName;
  status: "ready" | "mock" | "misconfigured" | "error";
  displayMode: MarketDataDisplayMode;
  realtimeEnabled: boolean;
  optionsRealtimeEnabled: boolean;
  overnightEnabled: boolean;
  source: string;
  message?: string;
  updatedAt: string;
}

export interface MarketQuote {
  symbol: string;
  assetType: AssetType;
  provider: MarketDataProviderName;
  source: string;
  displayMode: MarketDataDisplayMode;
  session: MarketSession;
  price: number | null;
  bid?: number | null;
  ask?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  previousClose?: number | null;
  change?: number | null;
  changePct?: number | null;
  volume?: number | null;
  timestamp: string;
  isMock: boolean;
  isDelayed: boolean;
  warning?: string;
}

/**
 * One normalized OHLCV bar from a historical (delayed) feed: real prices, an ISO
 * timestamp, and the ticker it belongs to. This is what the ingestion worker
 * stores — see MarketDataProvider.getDelayedBars.
 */
export interface DelayedBar {
  symbol: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** Bar timestamp — guaranteed to be at or before the requested cutoff. */
  observedAt: string;
}

export interface DelayedBarsResult {
  /** Newest bar at or before the cutoff, per symbol. Empty = no bar in range. */
  latestBySymbol: Map<string, DelayedBar>;
  windowStart: string;
  /** min(cutoff, dataset availability end) — the ceiling actually requested. */
  windowEnd: string;
  recordsFetched: number;
  /** True when the narrow window was empty and a wider one was used. */
  widened: boolean;
  /**
   * How far the provider's historical data reaches. Null when unknown. When this
   * is behind the cutoff, the feed itself — not our delay policy — is what
   * limits freshness, and callers must report the real bar age.
   */
  availableEnd?: string | null;
}

export interface MarketCandle {
  symbol: string;
  provider: MarketDataProviderName;
  source: string;
  displayMode: MarketDataDisplayMode;
  session?: MarketSession;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
  isMock: boolean;
  isDelayed: boolean;
}

export interface MarketMover {
  symbol: string;
  name?: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  session: MarketSession;
  reason?: string;
  timestamp: string;
  // Per-item provenance (filled by the service so each row is self-describing).
  source?: string;
  displayMode?: MarketDataDisplayMode;
}

export interface OptionContract {
  underlying: string;
  optionSymbol: string;
  expiration: string;
  strike: number;
  type: "call" | "put";
  provider: MarketDataProviderName;
  source: string;
  displayMode: MarketDataDisplayMode;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  mark?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  impliedVolatility?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  timestamp: string;
  isMock: boolean;
  isDelayed: boolean;
  warning?: string;
}

export interface OptionChainResponse {
  underlying: string;
  provider: MarketDataProviderName;
  source: string;
  displayMode: MarketDataDisplayMode;
  expirationDates: string[];
  contracts: OptionContract[];
  isMock: boolean;
  isDelayed: boolean;
  warning?: string;
  updatedAt: string;
}

/** Ticker social feed / mover reason etc. reuse this envelope for feeds. */
export interface TickerQuoteFeedResponse {
  symbol: string;
  provider: MarketDataProviderName;
  source: string;
  isMock: boolean;
  updatedAt: string;
}

/**
 * Market-data alert types (Phase-3 stubs). Alerts evaluation is NOT wired yet —
 * these exist so the UI can show "coming soon" without faking working alerts.
 */
export type MarketAlertType =
  | "price_above"
  | "price_below"
  | "percent_move"
  | "premarket_gap"
  | "after_hours_move"
  | "overnight_move"
  | "options_volume_spike";

export const MARKET_ALERT_TYPES: MarketAlertType[] = [
  "price_above",
  "price_below",
  "percent_move",
  "premarket_gap",
  "after_hours_move",
  "overnight_move",
  "options_volume_spike",
];
