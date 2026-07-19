import { query, queryOne } from "../lib/db.js";
import type { PositioningIndex, SignalScore, TrendRow } from "../types/domain.js";

/** Data access for metrics, trend classifications, signals and positioning. */
export const metricsRepository = {
  latest5mForTicker(ticker: string) {
    return queryOne(
      `SELECT * FROM public.ticker_metrics_5m WHERE ticker = $1
       ORDER BY bucket_start DESC LIMIT 1`,
      [ticker],
    );
  },

  trendByClassification(classification: string, limit = 15): Promise<TrendRow[]> {
    return query<TrendRow>(
      `SELECT ticker, classification, score, rank, evidence
       FROM public.ticker_trend_classifications
       WHERE classification = $1
       ORDER BY rank ASC NULLS LAST, score DESC
       LIMIT $2`,
      [classification, limit],
    );
  },

  /** Mention share across tickers for the most recent day. */
  mentionShare(limit = 15) {
    return query(
      `SELECT ticker, mentions, mention_share
       FROM public.ticker_daily_metrics
       WHERE day = (SELECT max(day) FROM public.ticker_daily_metrics)
       ORDER BY mentions DESC LIMIT $1`,
      [limit],
    );
  },

  /** Heatmap: latest 5m metrics for every ticker. */
  heatmap() {
    return query(
      `SELECT DISTINCT ON (ticker) ticker, mentions, sentiment_score, abnormality_score,
              mention_velocity, pump_language_score, bucket_start
       FROM public.ticker_metrics_5m
       ORDER BY ticker, bucket_start DESC`,
    );
  },

  signalsForTicker(ticker: string): Promise<SignalScore[]> {
    return query<SignalScore>(
      `SELECT * FROM public.signal_scores WHERE ticker = $1 ORDER BY created_at DESC`,
      [ticker],
    );
  },

  signalsByType(signalType: string): Promise<SignalScore[]> {
    return query<SignalScore>(
      `SELECT DISTINCT ON (ticker) * FROM public.signal_scores
       WHERE signal_type = $1 ORDER BY ticker, created_at DESC`,
      [signalType],
    );
  },

  positioningForTicker(ticker: string): Promise<PositioningIndex | null> {
    return queryOne<PositioningIndex>(
      `SELECT * FROM public.ticker_positioning_indexes WHERE ticker = $1
       ORDER BY bucket_start DESC LIMIT 1`,
      [ticker],
    );
  },

  positioningLatest(): Promise<PositioningIndex[]> {
    return query<PositioningIndex>(
      `SELECT DISTINCT ON (ticker) * FROM public.ticker_positioning_indexes
       ORDER BY ticker, bucket_start DESC`,
    );
  },

  attentionIndex() {
    return queryOne(
      `SELECT scope, bucket_start, index_value, label, components
       FROM public.market_attention_indexes WHERE scope = 'global'
       ORDER BY bucket_start DESC LIMIT 1`,
    );
  },

  pumpForTicker(ticker: string) {
    return queryOne(
      `SELECT * FROM public.pump_coordination_scores WHERE ticker = $1
       ORDER BY bucket_start DESC LIMIT 1`,
      [ticker],
    );
  },

  pumpLatest() {
    return query(
      `SELECT DISTINCT ON (ticker) * FROM public.pump_coordination_scores
       ORDER BY ticker, bucket_start DESC`,
    );
  },

  narrativesForTicker(ticker: string) {
    return query(
      `SELECT * FROM public.narrative_events WHERE ticker = $1 ORDER BY strength DESC`,
      [ticker],
    );
  },
};
