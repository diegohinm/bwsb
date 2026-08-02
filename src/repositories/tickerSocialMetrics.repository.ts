import { prisma } from "../lib/prisma.js";
import { PULSE_TIMEFRAME_MS, type PulseTimeframe } from "../services/social/socialData.types.js";

/**
 * Per-ticker social metrics — the handoff between worker and API for the
 * Popular Tickers sentiment column and the mentions-trend chart.
 *
 *   WORKER writes: replaceBuckets   (jobs/refreshTickerSocialMetrics)
 *   API reads:     readSentiment, readTrend
 *
 * Both reads hit ONE small pre-aggregated table. Nothing here touches
 * `social_posts` / `social_comments`, so toggling a ticker on the chart costs an
 * indexed lookup rather than a scan of the raw content.
 */

/** Bucket sizes stored, and how long each is worth keeping. */
export const BUCKET_SIZES = ["5m", "30m", "1h", "6h"] as const;
export type BucketSize = (typeof BUCKET_SIZES)[number];

export const BUCKET_MS: Record<BucketSize, number> = {
  "5m": 5 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
};

/**
 * THE window→resolution rule. Single source of truth: the worker uses it to
 * decide what to store and the API to decide what to read, so the two can never
 * disagree about which buckets belong to "24H".
 *
 * Chosen so every window plots between 12 and 28 points — enough to show a
 * shape, few enough to stay readable and cheap.
 */
export const BUCKET_FOR_TIMEFRAME: Record<PulseTimeframe, BucketSize> = {
  "1h": "5m",
  "6h": "30m",
  "24h": "1h",
  "7d": "6h",
};

export interface TickerSentiment {
  bullishPct: number;
  neutralPct: number;
  bearishPct: number;
  classifiedCount: number;
  dominant: "bullish" | "neutral" | "bearish" | null;
}

export interface BucketRow {
  ticker: string;
  bucketStart: Date;
  bucketSize: BucketSize;
  mentions: number;
  bullishCount: number;
  neutralCount: number;
  bearishCount: number;
}

// ── Worker writes ────────────────────────────────────────────────────────────

/**
 * Replace every bucket of one size at or after `fromIso`.
 *
 * Delete-then-insert rather than upsert-per-row: a recompute covers a bounded
 * window (at most a few hundred rows), and replacing it wholesale means a ticker
 * that stopped being mentioned correctly loses its stale bucket instead of
 * keeping the last value forever.
 */
export async function replaceBuckets(
  bucketSize: BucketSize,
  fromIso: string,
  rows: Omit<BucketRow, "bucketSize">[],
  meta: { provider: string; source: string; isMock: boolean },
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.tickerSocialMetricSnapshots.deleteMany({
      where: { bucketSize, bucketStart: { gte: new Date(fromIso) } },
    });
    if (rows.length === 0) return 0;

    const created = await tx.tickerSocialMetricSnapshots.createMany({
      data: rows.map((r) => ({
        ticker: r.ticker,
        bucketStart: r.bucketStart,
        bucketSize,
        mentions: r.mentions,
        bullishCount: r.bullishCount,
        neutralCount: r.neutralCount,
        bearishCount: r.bearishCount,
        provider: meta.provider,
        source: meta.source,
        isMock: meta.isMock,
      })),
    });
    return created.count;
  });
}

// ── API reads ────────────────────────────────────────────────────────────────

function windowStart(timeframe: PulseTimeframe, now = Date.now()): Date {
  return new Date(now - PULSE_TIMEFRAME_MS[timeframe]);
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

/**
 * Turn stance counts into a distribution.
 *
 * The denominator is the CLASSIFIED count, not the mention count: an item the
 * classifier could not read tells us nothing about sentiment, and folding it
 * into neutral would invent an opinion nobody expressed.
 *
 * Percentages are rounded to whole numbers and then the largest share absorbs
 * the rounding drift, so the three always sum to exactly 100 (or to 0 when
 * there is nothing classified).
 */
export function toSentiment(counts: {
  bullish: number;
  neutral: number;
  bearish: number;
}): TickerSentiment {
  const classifiedCount = counts.bullish + counts.neutral + counts.bearish;
  if (classifiedCount === 0) {
    return {
      bullishPct: 0,
      neutralPct: 0,
      bearishPct: 0,
      classifiedCount: 0,
      dominant: null,
    };
  }

  const parts = {
    bullishPct: pct(counts.bullish, classifiedCount),
    neutralPct: pct(counts.neutral, classifiedCount),
    bearishPct: pct(counts.bearish, classifiedCount),
  };

  // A tie prefers neutral: claiming a direction the data does not support is
  // worse than admitting the crowd is split.
  const max = Math.max(parts.bullishPct, parts.neutralPct, parts.bearishPct);
  const dominant: NonNullable<TickerSentiment["dominant"]> =
    parts.neutralPct === max ? "neutral" : parts.bullishPct === max ? "bullish" : "bearish";

  // Whole-number rounding leaves the three a point or two short of 100; the
  // dominant share absorbs it so the bar always fills exactly.
  const drift = 100 - (parts.bullishPct + parts.neutralPct + parts.bearishPct);
  parts[`${dominant}Pct`] += drift;

  return { ...parts, classifiedCount, dominant };
}

/**
 * Sentiment per ticker inside a window, summed from the stored buckets for that
 * window's resolution.
 */
export async function readSentiment(
  timeframe: PulseTimeframe,
  tickers?: string[],
): Promise<Map<string, TickerSentiment>> {
  const groups = await prisma.tickerSocialMetricSnapshots.groupBy({
    by: ["ticker"],
    where: {
      bucketSize: BUCKET_FOR_TIMEFRAME[timeframe],
      bucketStart: { gte: windowStart(timeframe) },
      ...(tickers?.length ? { ticker: { in: tickers } } : {}),
    },
    _sum: { bullishCount: true, neutralCount: true, bearishCount: true, mentions: true },
  });

  const out = new Map<string, TickerSentiment>();
  for (const g of groups) {
    out.set(
      g.ticker.toUpperCase(),
      toSentiment({
        bullish: g._sum.bullishCount ?? 0,
        neutral: g._sum.neutralCount ?? 0,
        bearish: g._sum.bearishCount ?? 0,
      }),
    );
  }
  return out;
}

export interface TrendSeries {
  symbol: string;
  points: { timestamp: string; mentions: number }[];
}

/** Mention series per symbol, at the resolution the window calls for. */
export async function readTrend(
  symbols: string[],
  timeframe: PulseTimeframe,
): Promise<{ series: TrendSeries[]; bucket: BucketSize; updatedAt: string | null }> {
  const bucket = BUCKET_FOR_TIMEFRAME[timeframe];
  const rows = await prisma.tickerSocialMetricSnapshots.findMany({
    where: {
      ticker: { in: symbols },
      bucketSize: bucket,
      bucketStart: { gte: windowStart(timeframe) },
    },
    orderBy: { bucketStart: "asc" },
    select: { ticker: true, bucketStart: true, mentions: true },
  });

  const bySymbol = new Map<string, TrendSeries["points"]>(symbols.map((s) => [s, []]));
  let newest: Date | null = null;
  for (const r of rows) {
    const key = r.ticker.toUpperCase();
    bySymbol.get(key)?.push({
      timestamp: r.bucketStart.toISOString(),
      mentions: r.mentions,
    });
    if (!newest || r.bucketStart > newest) newest = r.bucketStart;
  }

  return {
    // Every requested symbol comes back, empty series included — "no data" is an
    // answer the chart must be able to render.
    series: symbols.map((symbol) => ({ symbol, points: bySymbol.get(symbol) ?? [] })),
    bucket,
    updatedAt: newest?.toISOString() ?? null,
  };
}

/** Provenance of the freshest stored bucket, for the response envelope. */
export async function readMetricsMeta(): Promise<{
  provider: string;
  source: string;
  isMock: boolean;
} | null> {
  const row = await prisma.tickerSocialMetricSnapshots.findFirst({
    orderBy: { bucketStart: "desc" },
    select: { provider: true, source: true, isMock: true },
  });
  if (!row) return null;
  return {
    provider: row.provider ?? "mock",
    source: row.source ?? row.provider ?? "mock",
    isMock: row.isMock,
  };
}
