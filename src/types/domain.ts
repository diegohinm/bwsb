/**
 * Shared backend domain types. These mirror the database rows and the JSON
 * shapes returned by the API. Kept intentionally close to the SQL columns.
 */

export type Direction = "bullish" | "bearish" | "neutral" | "unknown";
export type Instrument = "stock" | "option" | "spread" | "unknown";
export type OptionType = "call" | "put";
export type Moneyness = "ITM" | "ATM" | "OTM" | "unknown";
export type PositionIntent =
  | "real_position"
  | "pending_order"
  | "future_intent"
  | "question"
  | "hypothesis"
  | "recommendation"
  | "sarcasm"
  | "meme"
  | "closed_position"
  | "unverified";
export type BetStatus =
  | "open"
  | "closed"
  | "expired"
  | "assigned"
  | "rolled"
  | "unknown";
export type VerificationLevel =
  | "text_only"
  | "screenshot_detected"
  | "internally_consistent"
  | "market_validated"
  | "follow_up_verified"
  | "unverified";

export interface Ticker {
  ticker: string;
  company_name: string | null;
  exchange: string | null;
  is_active: boolean | null;
  is_common_word: boolean | null;
  created_at?: string | null;
}

export interface RedditPost {
  reddit_post_id: string;
  subreddit: string;
  title: string;
  body_excerpt: string | null;
  author_hash: string;
  score: number;
  num_comments: number;
  permalink: string | null;
  reddit_created_at: string | null;
  created_at: string;
}

export interface TickerMention {
  id: number;
  ticker: string;
  reddit_post_id: string;
  pump_language_score: number;
  narrative_type: string | null;
  created_at: string;
}

export interface Bet {
  id: string;
  source_type: string;
  reddit_post_id: string | null;
  reddit_comment_id: string | null;
  author_hash: string | null;
  ticker: string | null;
  direction: Direction | null;
  instrument: Instrument | null;
  option_type: OptionType | null;
  position_intent: PositionIntent | null;
  status: BetStatus | null;
  declared_capital: number | null;
  verified_capital: number | null;
  notional_exposure: number | null;
  max_loss: number | null;
  max_gain: number | null;
  breakeven: number | null;
  entry_underlying_price: number | null;
  entry_timestamp: string | null;
  extraction_confidence: number | null;
  verification_level: VerificationLevel | null;
  raw_evidence: unknown;
  created_at: string;
  updated_at: string;
}

export interface BetLeg {
  id: string;
  bet_id: string;
  leg_type: "stock" | "option" | null;
  side: "long" | "short" | null;
  option_type: OptionType | null;
  strike: number | null;
  expiration_date: string | null;
  contracts: number | null;
  shares: number | null;
  premium: number | null;
  price: number | null;
  dte: number | null;
  moneyness: Moneyness | null;
  delta: number | null;
  theta: number | null;
  vega: number | null;
  implied_volatility: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  created_at: string;
}

export interface BetSnapshot {
  id: string;
  bet_id: string;
  snapshot_at: string;
  underlying_price: number | null;
  estimated_option_value: number | null;
  estimated_position_value: number | null;
  return_pct: number | null;
  unrealized_pl: number | null;
  max_gain_so_far: number | null;
  max_loss_so_far: number | null;
  metadata: unknown;
}

export interface SignalScore {
  id: string;
  ticker: string | null;
  bucket_start: string | null;
  signal_type: string;
  score: number | null;
  confidence: number | null;
  explanation: string | null;
  evidence: unknown;
  created_at: string;
}

export interface PositioningIndex {
  id: string;
  ticker: string | null;
  bucket_start: string | null;
  call_conviction: number | null;
  put_conviction: number | null;
  net_directional_conviction: number | null;
  declared_yolo_capital: number | null;
  verified_yolo_capital: number | null;
  average_dte: number | null;
  average_moneyness: number | null;
  premium_at_risk: number | null;
  leveraged_sentiment: number | null;
  expiration_wall: unknown;
  created_at: string;
}

export interface TickerAlert {
  id: string;
  ticker: string;
  alert_type: string;
  severity: string;
  explanation: string | null;
  metrics_snapshot: unknown;
  evidence: unknown;
  created_at: string;
}

export interface TrendRow {
  ticker: string;
  classification: string;
  score: number;
  rank: number | null;
  evidence: unknown;
}

export interface BacktestResult {
  id: string;
  backtest_run_id: string;
  observations: number | null;
  win_rate: number | null;
  median_return: number | null;
  average_return: number | null;
  max_drawdown: number | null;
  spy_adjusted_return: number | null;
  option_estimated_return: number | null;
  result_distribution: unknown;
  created_at: string;
}

export interface ResearchReport {
  id: string;
  slug: string | null;
  title: string;
  summary: string | null;
  body: string | null;
  report_type: string | null;
  tickers: unknown;
  metadata: unknown;
  created_at: string;
}

export interface MarketSnapshot {
  id: string;
  ticker: string;
  snapshot_at: string;
  price: number | null;
  change_pct: number | null;
  volume: number | null;
  avg_volume: number | null;
  market_cap: number | null;
  beta: number | null;
  source: string;
  metadata: unknown;
}

/** Demo user id used before real per-user auth is wired into these features. */
export const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";
