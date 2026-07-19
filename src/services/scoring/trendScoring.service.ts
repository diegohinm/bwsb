/**
 * trendScoring.service.ts
 *
 * Ranks and classifies tickers into internal trend categories based on plain
 * per-ticker metric rows. Pure, deterministic rule-based math with no I/O.
 * Each category defines a scoring function; `rankByCategory` sorts descending.
 */

export interface TrendMetricRow {
  ticker: string;
  mentions: number;
  sentiment_score: number; // -1..1, negative = bearish
  mention_velocity: number; // recent rate of change
  abnormality_score: number; // 0..1, unusualness vs baseline
  pump_language_score: number; // 0..1, hype/coordination language
}

export type TrendCategory =
  | "most_mentioned"
  | "acceleration"
  | "fresh_breakout"
  | "bullish_pressure"
  | "bearish_pressure"
  | "disagreement"
  | "one_sided_attention"
  | "penny_attention";

export interface RankedTicker {
  ticker: string;
  score: number;
  rank: number;
}

/** Compute a raw category score for a single row (higher = stronger fit). */
export function categoryScore(row: TrendMetricRow, category: TrendCategory): number {
  const m = Math.max(0, row.mentions);
  const s = Math.max(-1, Math.min(1, row.sentiment_score));
  const v = row.mention_velocity;
  const a = Math.max(0, Math.min(1, row.abnormality_score));
  const p = Math.max(0, Math.min(1, row.pump_language_score));

  switch (category) {
    case "most_mentioned":
      return m;
    case "acceleration":
      return v * (1 + a);
    case "fresh_breakout":
      return a * Math.log1p(m);
    case "bullish_pressure":
      return Math.max(0, s) * Math.log1p(m);
    case "bearish_pressure":
      return Math.max(0, -s) * Math.log1p(m);
    case "disagreement":
      return (1 - Math.abs(s)) * Math.log1p(m);
    case "one_sided_attention":
      return Math.abs(s) * Math.log1p(m);
    case "penny_attention":
      return p * Math.log1p(m);
    default:
      return 0;
  }
}

/** Rank rows for a category, returning the top `limit` scored + ranked. */
export function rankByCategory(
  rows: TrendMetricRow[],
  category: TrendCategory,
  limit = 10,
): RankedTicker[] {
  const scored = rows
    .map((r) => ({ ticker: r.ticker, score: Math.round(categoryScore(r, category) * 1000) / 1000 }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));

  return scored.map((r, i) => ({ ...r, rank: i + 1 }));
}
