import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { num } from "../../lib/numeric.js";
import { increment } from "../../lib/metrics.js";
import type { CandleTimeframe, MarketCandle } from "./marketData.types.js";

/**
 * HISTORICAL BARS, BOUGHT ONCE.
 *
 * A candle for a period that has already closed never changes again. Yet
 * `GET /api/market-data/candles/:symbol` went straight to the provider on every
 * request, behind a ten-second in-memory cache that every deploy erased — so the
 * same month of NVDA daily bars was fetched over and over, and identically, for
 * as long as anyone kept the chart open.
 *
 * This module makes the stored bars authoritative and reduces the provider to
 * whatever is genuinely absent.
 */

export type StoredCandle = {
  ticker: string;
  interval: CandleTimeframe;
  timestamp: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  provider: string | null;
};

export type CandleRange = { from: Date; to: Date };

/** Stored bars for a symbol and interval, oldest first. */
export async function readCachedCandles(
  ticker: string,
  interval: CandleTimeframe,
  range: CandleRange,
): Promise<StoredCandle[]> {
  const rows = await prisma.marketCandle.findMany({
    where: {
      ticker: ticker.toUpperCase(),
      interval,
      timestamp: { gte: range.from, lte: range.to },
    },
    orderBy: { timestamp: "asc" },
  });

  return rows.map((r) => ({
    ticker: r.ticker,
    interval: r.interval as CandleTimeframe,
    timestamp: r.timestamp,
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume: num(r.volume),
    provider: r.provider,
  }));
}

/**
 * What is missing from the requested range, as ranges to go and fetch.
 *
 * EDGES, NOT HOLES — and that is a decision, not an oversight. Candle series are
 * legitimately full of gaps: weekends, holidays, halts, and every overnight for
 * an intraday interval. Treating an absent bar as a gap to fill would mean
 * re-requesting every weekend forever and being told "no data" every time, which
 * costs exactly as much as fetching real data and never converges.
 *
 * So the question asked is the one that has a stable answer: does the stored
 * series COVER the requested span? The parts before the first stored bar and
 * after the last one are what is genuinely unfetched.
 *
 *   request  2026-09-01 → 2026-09-10
 *   stored   2026-09-01 → 2026-09-08
 *   missing  2026-09-08 → 2026-09-10      (not the whole range)
 *
 * The trailing fetch restarts AT the newest stored bar rather than after it: the
 * most recent bar may have been captured while its period was still open, and
 * re-fetching it overwrites a partial bar with the closed one. Writes are keyed
 * on (ticker, interval, timestamp), so the overlap costs one upsert, not a
 * duplicate.
 *
 * KNOWN LIMITATION: an interior hole left by a download that failed half way is
 * invisible to this and will not be repaired automatically. `market_candles` is
 * keyed for idempotent overwrite, so the repair is a re-fetch of the affected
 * range — see the remaining-debt notes.
 */
export async function missingCandleRanges(
  ticker: string,
  interval: CandleTimeframe,
  range: CandleRange,
): Promise<CandleRange[]> {
  const bounds = await prisma.marketCandle.aggregate({
    where: {
      ticker: ticker.toUpperCase(),
      interval,
      timestamp: { gte: range.from, lte: range.to },
    },
    _min: { timestamp: true },
    _max: { timestamp: true },
  });

  const first = bounds._min.timestamp;
  const last = bounds._max.timestamp;

  // Nothing stored for this span at all.
  if (!first || !last) return [{ from: range.from, to: range.to }];

  const gaps: CandleRange[] = [];
  if (first.getTime() > range.from.getTime()) gaps.push({ from: range.from, to: first });
  if (last.getTime() < range.to.getTime()) gaps.push({ from: last, to: range.to });
  return gaps;
}

/**
 * Whether the provider needs to be involved at all.
 *
 * Separate from `missingCandleRanges` because the answer drives a metric the
 * refactor is meant to move: a chart that opens with zero provider requests is
 * the success condition, and it has to be countable.
 */
export async function candleCoverage(
  ticker: string,
  interval: CandleTimeframe,
  range: CandleRange,
): Promise<{ candles: StoredCandle[]; gaps: CandleRange[] }> {
  const [candles, gaps] = await Promise.all([
    readCachedCandles(ticker, interval, range),
    missingCandleRanges(ticker, interval, range),
  ]);

  if (gaps.length === 0) increment("market_candle_cache_hits");
  else increment("market_candle_cache_misses");

  return { candles, gaps };
}

export type CandleUpsert = {
  ticker: string;
  interval: CandleTimeframe;
  timestamp: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  provider: string | null;
};

/**
 * Store fetched bars.
 *
 * ON CONFLICT DO UPDATE rather than DO NOTHING: the newest bar in a fetch is
 * routinely a period still in progress, and the next fetch carries its closed
 * values. Refusing the overwrite would freeze a partial bar into the cache
 * permanently.
 */
export async function saveCandles(rows: CandleUpsert[]): Promise<number> {
  if (rows.length === 0) return 0;

  // Deduplicated in memory: a multi-row INSERT may not name the same key twice,
  // and providers do occasionally repeat a bar across page boundaries.
  const byKey = new Map<string, CandleUpsert>();
  for (const row of rows) {
    byKey.set(`${row.ticker}|${row.interval}|${row.timestamp.toISOString()}`, row);
  }

  const values = [...byKey.values()].map(
    (r) => Prisma.sql`(${r.ticker.toUpperCase()}, ${r.interval}, ${r.timestamp},
                       ${r.open}, ${r.high}, ${r.low}, ${r.close}, ${r.volume}, ${r.provider})`,
  );

  return prisma.$executeRaw(Prisma.sql`
    INSERT INTO market_candles
      (ticker, interval, "timestamp", open, high, low, close, volume, provider)
    VALUES ${Prisma.join(values, ", ")}
    ON CONFLICT (ticker, interval, "timestamp") DO UPDATE SET
      open       = EXCLUDED.open,
      high       = EXCLUDED.high,
      low        = EXCLUDED.low,
      close      = EXCLUDED.close,
      volume     = EXCLUDED.volume,
      provider   = EXCLUDED.provider,
      updated_at = now()`);
}

/** Convert a provider candle into the stored shape. */
export function toCandleUpsert(
  ticker: string,
  interval: CandleTimeframe,
  candle: MarketCandle,
): CandleUpsert {
  return {
    ticker: ticker.toUpperCase(),
    interval,
    timestamp: new Date(candle.timestamp),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    provider: candle.provider,
  };
}
