import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import { toDbRow, toDbRows } from "../lib/rows.js";
import type { PositioningIndex, SignalScore, TrendRow } from "../types/domain.js";

/**
 * Data access for metrics, trend classifications, signals and positioning.
 *
 * Rows are returned with their database column names (see lib/rows.ts) because
 * the trends/signals routes serialize them straight onto the wire.
 *
 * Several reads want "the newest row per ticker", which SQL wrote as
 * `DISTINCT ON (ticker) … ORDER BY ticker, <time> DESC`. Prisma has no
 * DISTINCT ON, so each one groups to find the newest key per ticker and then
 * fetches exactly those rows — two indexed queries instead of reading the whole
 * table and filtering in memory.
 */
/** The 5-minute metrics row, as the signals/trends routes consume it. */
export interface TickerMetrics5mRow {
  ticker: string;
  bucket_start: Date;
  mentions: number;
  posts_count: number;
  unique_authors: number;
  avg_score: number;
  total_comments: number;
  mention_velocity: number;
  abnormality_score: number;
  sentiment_score: number;
  pump_language_score: number;
  created_at: Date;
}

/** A pump-coordination score row, as the alert engine consumes it. */
export interface PumpCoordinationRow {
  id: string;
  ticker: string | null;
  bucket_start: Date | null;
  score: number | null;
  severity: string | null;
  repeated_phrases: unknown;
  author_concentration: number | null;
  new_account_ratio: number | null;
  cross_subreddit_activity: unknown;
  deletion_rate: number | null;
  explanation: string | null;
  created_at: Date;
}

export const metricsRepository = {
  async latest5mForTicker(ticker: string): Promise<TickerMetrics5mRow | null> {
    const row = await prisma.tickerMetrics5m.findFirst({
      where: { ticker },
      orderBy: { bucketStart: "desc" },
    });
    return row ? toDbRow<TickerMetrics5mRow>("TickerMetrics5m", row) : null;
  },

  async trendByClassification(classification: string, limit = 15): Promise<TrendRow[]> {
    const rows = await prisma.tickerTrendClassifications.findMany({
      where: { classification },
      select: {
        ticker: true,
        classification: true,
        score: true,
        rank: true,
        evidence: true,
      },
      orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { score: "desc" }],
      take: limit,
    });
    return toDbRows<TrendRow>("TickerTrendClassifications", rows);
  },

  /** Mention share across tickers for the most recent day. */
  async mentionShare(limit = 15) {
    const newest = await prisma.tickerDailyMetrics.aggregate({ _max: { day: true } });
    if (!newest._max.day) return [];

    const rows = await prisma.tickerDailyMetrics.findMany({
      where: { day: newest._max.day },
      select: { ticker: true, mentions: true, mentionShare: true },
      orderBy: { mentions: "desc" },
      take: limit,
    });
    return toDbRows("TickerDailyMetrics", rows);
  },

  /** Heatmap: latest 5m metrics for every ticker. */
  async heatmap() {
    const newestPerTicker = await prisma.tickerMetrics5m.groupBy({
      by: ["ticker"],
      _max: { bucketStart: true },
    });
    const keys = newestPerTicker
      .filter((g) => g._max.bucketStart !== null)
      .map((g) => ({ ticker: g.ticker, bucketStart: g._max.bucketStart! }));
    if (keys.length === 0) return [];

    const rows = await prisma.tickerMetrics5m.findMany({
      where: { OR: keys },
      select: {
        ticker: true,
        mentions: true,
        sentimentScore: true,
        abnormalityScore: true,
        mentionVelocity: true,
        pumpLanguageScore: true,
        bucketStart: true,
      },
      orderBy: { ticker: "asc" },
    });
    return toDbRows("TickerMetrics5m", rows);
  },

  async signalsForTicker(ticker: string): Promise<SignalScore[]> {
    const rows = await prisma.signalScores.findMany({
      where: { ticker },
      orderBy: { createdAt: "desc" },
    });
    return toDbRows<SignalScore>("SignalScores", rows);
  },

  /** Newest signal per ticker for one signal type. */
  async signalsByType(signalType: string): Promise<SignalScore[]> {
    const newestPerTicker = await prisma.signalScores.groupBy({
      by: ["ticker"],
      where: { signalType },
      _max: { createdAt: true },
    });
    const keys = newestPerTicker
      .filter((g) => g.ticker !== null && g._max.createdAt !== null)
      .map((g) => ({ ticker: g.ticker, createdAt: g._max.createdAt! }));
    if (keys.length === 0) return [];

    const rows = await prisma.signalScores.findMany({
      where: { signalType, OR: keys },
      orderBy: { ticker: "asc" },
    });
    return toDbRows<SignalScore>("SignalScores", rows);
  },

  async positioningForTicker(ticker: string): Promise<PositioningIndex | null> {
    const row = await prisma.tickerPositioningIndexes.findFirst({
      where: { ticker },
      orderBy: { bucketStart: "desc" },
    });
    return row ? toDbRow<PositioningIndex>("TickerPositioningIndexes", row) : null;
  },

  async positioningLatest(): Promise<PositioningIndex[]> {
    const newestPerTicker = await prisma.tickerPositioningIndexes.groupBy({
      by: ["ticker"],
      _max: { bucketStart: true },
    });
    const keys = newestPerTicker
      .filter((g) => g.ticker !== null && g._max.bucketStart !== null)
      .map((g) => ({ ticker: g.ticker, bucketStart: g._max.bucketStart! }));
    if (keys.length === 0) return [];

    const rows = await prisma.tickerPositioningIndexes.findMany({
      where: { OR: keys },
      orderBy: { ticker: "asc" },
    });
    return toDbRows<PositioningIndex>("TickerPositioningIndexes", rows);
  },

  async attentionIndex() {
    const row = await prisma.marketAttentionIndexes.findFirst({
      where: { scope: "global" },
      select: {
        scope: true,
        bucketStart: true,
        indexValue: true,
        label: true,
        components: true,
      },
      orderBy: { bucketStart: "desc" },
    });
    return row ? toDbRow("MarketAttentionIndexes", row) : null;
  },

  async pumpForTicker(ticker: string): Promise<PumpCoordinationRow | null> {
    const row = await prisma.pumpCoordinationScores.findFirst({
      where: { ticker },
      orderBy: { bucketStart: "desc" },
    });
    return row ? toDbRow<PumpCoordinationRow>("PumpCoordinationScores", row) : null;
  },

  async pumpLatest(): Promise<PumpCoordinationRow[]> {
    const newestPerTicker = await prisma.pumpCoordinationScores.groupBy({
      by: ["ticker"],
      _max: { bucketStart: true },
    });
    const keys = newestPerTicker
      .filter((g) => g.ticker !== null && g._max.bucketStart !== null)
      .map((g) => ({ ticker: g.ticker, bucketStart: g._max.bucketStart! }));
    if (keys.length === 0) return [];

    const rows = await prisma.pumpCoordinationScores.findMany({
      where: { OR: keys },
      orderBy: { ticker: "asc" },
    });
    return toDbRows<PumpCoordinationRow>("PumpCoordinationScores", rows);
  },

  /**
   * Track record across every resolved author signal.
   *
   * `count(*) FILTER (WHERE outcome = 'win')` has no Prisma equivalent, so the
   * win count is a second counting query rather than a scan in memory.
   */
  async resolvedSignalStats(): Promise<{
    resolved: number;
    wins: number;
    avg_return: number | null;
  }> {
    const resolved = { resolvedAt: { not: null } };

    const [totals, wins] = await Promise.all([
      prisma.authorSignalHistory.aggregate({
        where: resolved,
        _count: { _all: true },
        _avg: { returnPct: true },
      }),
      prisma.authorSignalHistory.count({ where: { ...resolved, outcome: "win" } }),
    ]);

    const average = num(totals._avg.returnPct);
    return {
      resolved: totals._count._all,
      wins,
      avg_return: average === null ? null : Math.round(average * 100) / 100,
    };
  },

  async narrativesForTicker(ticker: string) {
    const rows = await prisma.narrativeEvents.findMany({
      where: { ticker },
      orderBy: { strength: "desc" },
    });
    return toDbRows("NarrativeEvents", rows);
  },
};
