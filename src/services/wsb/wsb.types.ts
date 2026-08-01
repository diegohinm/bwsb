/**
 * Shared contract for the WSB workspace (Portfolio + Banbets).
 *
 * Same rules as the rest of the platform: the API serves these shapes from
 * DATABASE SNAPSHOTS only, every response carries `provider` / `source` /
 * `isMock` / `updatedAt` so the UI can badge demo data honestly, and no route
 * that returns one of these types may call an upstream provider.
 */

/** Windows the WSB workspace aggregates over. */
export const WSB_TIMEFRAMES = ["24h", "7d", "30d"] as const;
export type WsbTimeframe = (typeof WSB_TIMEFRAMES)[number];

export const WSB_TIMEFRAME_MS: Record<WsbTimeframe, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function isWsbTimeframe(value: unknown): value is WsbTimeframe {
  return (
    typeof value === "string" && (WSB_TIMEFRAMES as readonly string[]).includes(value)
  );
}

/**
 * How much we actually know about a position. The UI may surface this so a
 * parsed one-liner is never presented with the same authority as a confirmed
 * position — see `positionExtractor.service.ts` for what earns each level.
 */
export const VERIFICATION_LEVELS = [
  "verified",
  "screenshot",
  "extracted",
  "text_only",
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Option duration buckets. `long` is the UI's name for LEAPS. */
export const DURATION_BUCKETS = ["zero_dte", "weekly", "swing", "leaps"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export type OptionType = "call" | "put";

export interface WsbResponseMeta {
  provider: string;
  source: string;
  isMock: boolean;
  updatedAt: string | null;
  /** Non-blocking note, e.g. a partial ingestion run. */
  warning?: string;
}

export interface WsbPortfolioSummary {
  timeframe: WsbTimeframe;
  traders: number;
  bullishPct: number;
  totalExposure: number;
  allocation: {
    optionsPct: number;
    stocksPct: number;
    cryptoPct: number;
  };
  duration: {
    zeroDte: number;
    weekly: number;
    swing: number;
    leaps: number;
  };
}

export interface WsbOptionPosition {
  rank: number;
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  dte: number;
  durationBucket: DurationBucket;
  holders: number;
  quantity: number;
  value: number;
  bullishPct: number;
  changePct: number | null;
  verificationLevel: VerificationLevel;
}

export interface WsbStockPosition {
  rank: number;
  ticker: string;
  company: string | null;
  holders: number;
  shares: number;
  value: number;
  bullishPct: number;
  changePct: number | null;
  topSubreddit: string | null;
  verificationLevel: VerificationLevel;
}

export interface WsbCryptoPosition {
  rank: number;
  asset: string | null;
  symbol: string;
  holders: number;
  quantity: number;
  value: number;
  bullishPct: number;
  changePct: number | null;
  verificationLevel: VerificationLevel;
}

/** Page envelope shared by the three position tables. */
export interface WsbPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export const OPTION_SORTS = ["value", "holders", "quantity", "sentiment"] as const;
export type OptionSort = (typeof OPTION_SORTS)[number];

/** `long` maps to the LEAPS bucket — the UI label differs from the storage name. */
export const DURATION_FILTERS = ["all", "0dte", "weekly", "swing", "long"] as const;
export type DurationFilter = (typeof DURATION_FILTERS)[number];

// ── Banbets ──────────────────────────────────────────────────────────────────

export const BANBET_STATUSES = ["open", "won", "lost", "expired"] as const;
export type BanbetStatus = (typeof BANBET_STATUSES)[number];

export type BanbetSide = "bull" | "bear";
export type BanbetOperator = "gte" | "lte";

export interface WsbBanbet {
  id: string;
  /** Display handle when the source permits it; otherwise a short hash label. */
  username: string;
  ticker: string;
  operator: BanbetOperator;
  targetPrice: number;
  side: BanbetSide;
  status: BanbetStatus;
  resultPct: number | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  subreddit: string | null;
  sourceUrl: string | null;
}

export interface WsbBanbetActivity {
  recentlyResolved: WsbBanbet[];
  expiringSoon: WsbBanbet[];
}

export const BANBET_SECTIONS = ["all", "resolved", "expiring"] as const;
export type BanbetSection = (typeof BANBET_SECTIONS)[number];

export const BANBET_SORTS = ["recent", "expiring", "result"] as const;
export type BanbetSort = (typeof BANBET_SORTS)[number];
