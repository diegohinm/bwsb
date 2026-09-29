import { prisma } from "../../lib/prisma.js";

/**
 * REALIZED VOLATILITY — how much this ticker has actually been moving.
 *
 * The score needs a yardstick: +10% means one thing on an index and another on
 * something that swings 8% a session. This is that yardstick, and it is read
 * from bars the worker already stored, never from a live provider call.
 *
 * REALIZED, NOT IMPLIED. Implied vol would be better in principle — it is the
 * market's forward view — but it needs an options chain per ticker per bet,
 * which is a metered request on the creation path. Realized vol over the
 * trailing month is free, already in the database, and good enough to separate
 * "calm" from "wild", which is all the difficulty ratio needs it to do.
 *
 * FROZEN AT ENTRY. The caller stores the returned number on the bet and never
 * recomputes it. Rescoring a settled call with volatility measured afterwards
 * would let the very move being predicted change how hard it was to predict —
 * a correct 40% call on a stock that then went quiet would look harder in
 * hindsight than it was at the time, and the leaderboard would reward luck.
 */

/** Trading days sampled. ~30 calendar days, which is the industry default. */
const LOOKBACK_TRADING_DAYS = 21;

/** Bars required before a figure is reported at all. */
const MIN_RETURNS = 10;

/** Trading days per year — the annualization factor for daily returns. */
const TRADING_DAYS_PER_YEAR = 252;

export interface VolatilityResult {
  /** Annualized standard deviation of daily log returns, as a decimal. */
  volatility: number;
  /** How many daily returns it was computed from. */
  sampleSize: number;
  /** The newest bar used — so staleness is visible rather than assumed away. */
  asOf: Date;
}

/**
 * Annualized realized volatility for a ticker as of an instant.
 *
 * Returns null rather than a guess when there is not enough history: a freshly
 * listed ticker genuinely has no measurable volatility, and inventing one would
 * put an unearned difficulty on every bet placed against it.
 */
export async function realizedVolatility(
  ticker: string,
  asOf: Date = new Date(),
): Promise<VolatilityResult | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  const bars = await prisma.marketCandle.findMany({
    where: {
      ticker: symbol,
      interval: "1d",
      // STRICTLY BEFORE the instant in question. A bar that opened after the
      // bet was placed describes the future; including it is exactly the
      // look-ahead this module exists to prevent.
      timestamp: { lt: asOf },
      close: { not: null },
    },
    orderBy: { timestamp: "desc" },
    take: LOOKBACK_TRADING_DAYS + 1,
    select: { timestamp: true, close: true },
  });

  if (bars.length < MIN_RETURNS + 1) return null;

  // Oldest first, so consecutive pairs are a return.
  const closes = bars
    .map((b) => ({ timestamp: b.timestamp, close: Number(b.close) }))
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .reverse();

  if (closes.length < MIN_RETURNS + 1) return null;

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i]!.close / closes[i - 1]!.close));
  }

  if (returns.length < MIN_RETURNS) return null;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  // Sample variance (n-1): these returns are a sample of the ticker's
  // behaviour, not the whole population of it.
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const daily = Math.sqrt(variance);
  const annualized = daily * Math.sqrt(TRADING_DAYS_PER_YEAR);

  if (!Number.isFinite(annualized) || annualized <= 0) return null;

  return {
    volatility: Math.round(annualized * 1e6) / 1e6,
    sampleSize: returns.length,
    asOf: closes[closes.length - 1]!.timestamp,
  };
}

/**
 * The same computation over closes supplied directly.
 *
 * Exported for the backfill, which reconstructs a historical banbet's
 * volatility from bars around its creation date, and for tests that must not
 * need a database.
 */
export function volatilityFromCloses(closes: number[]): number | null {
  const clean = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (clean.length < MIN_RETURNS + 1) return null;

  const returns: number[] = [];
  for (let i = 1; i < clean.length; i++) returns.push(Math.log(clean[i]! / clean[i - 1]!));

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const annualized = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  if (!Number.isFinite(annualized) || annualized <= 0) return null;
  return Math.round(annualized * 1e6) / 1e6;
}

export const VOLATILITY_PARAMS = {
  lookbackTradingDays: LOOKBACK_TRADING_DAYS,
  minReturns: MIN_RETURNS,
  tradingDaysPerYear: TRADING_DAYS_PER_YEAR,
} as const;
