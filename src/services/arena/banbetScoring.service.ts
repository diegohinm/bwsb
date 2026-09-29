import { prisma } from "../../lib/prisma.js";
import { volatilityFromCloses } from "./realizedVolatility.service.js";
import { calculateYoloScore } from "./yoloScore.service.js";
import { VOLATILITY_PARAMS } from "./realizedVolatility.service.js";

/**
 * SCORING HISTORICAL BANBETS.
 *
 * A banbet arrives from Reddit with a ticker, a target, a direction and a
 * deadline — but no entry price and no volatility, because r/wallstreetbets'
 * bot never recorded either. Both have to be RECONSTRUCTED from the bars
 * around the moment the bet was made.
 *
 * THE RULE THAT MATTERS: reconstruct from bars strictly BEFORE creation, never
 * after. It is tempting to use the full history we now have, but volatility
 * measured across the period the bet was predicting would let the outcome
 * change the difficulty of the prediction — a correct call on a stock that
 * then went wild would look easy in hindsight.
 *
 * WHEN THE BARS ARE NOT THERE, NOTHING IS WRITTEN. `scoring_version` stays
 * NULL, the row is excluded from score sums, and the UI prints N/A. A
 * fabricated entry price would produce a plausible score for a bet nobody can
 * check, which is worse than an empty cell.
 */

export interface BanbetScoringResult {
  examined: number;
  scored: number;
  skippedNoEntryPrice: number;
  skippedNoVolatility: number;
  skippedUnscorable: number;
}

/** The close on or just before an instant — the entry price we never had. */
async function closeAsOf(ticker: string, at: Date): Promise<number | null> {
  const bar = await prisma.marketCandle.findFirst({
    where: { ticker: ticker.toUpperCase(), interval: "1d", timestamp: { lte: at }, close: { not: null } },
    orderBy: { timestamp: "desc" },
    select: { close: true },
  });
  if (!bar?.close) return null;
  const price = Number(bar.close);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Trailing closes strictly before an instant, oldest first. */
async function trailingCloses(ticker: string, before: Date): Promise<number[]> {
  const bars = await prisma.marketCandle.findMany({
    where: { ticker: ticker.toUpperCase(), interval: "1d", timestamp: { lt: before }, close: { not: null } },
    orderBy: { timestamp: "desc" },
    take: VOLATILITY_PARAMS.lookbackTradingDays + 1,
    select: { close: true },
  });
  return bars
    .map((b) => Number(b.close))
    .filter((c) => Number.isFinite(c) && c > 0)
    .reverse();
}

/**
 * Score every confirmed banbet that has a resolution and no score yet.
 *
 * Idempotent: rows already carrying a `scoring_version` are skipped, so a
 * re-run neither double-counts nor silently rescores history under a newer
 * formula. Changing the formula means writing a v2 pass, not re-running this.
 */
export async function scoreUnscoredBanbets(limit = 500): Promise<BanbetScoringResult> {
  const rows = await prisma.wsbBanbets.findMany({
    where: {
      scoringVersion: null,
      confirmation: "confirmed",
      status: { in: ["won", "lost", "expired"] },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const result: BanbetScoringResult = {
    examined: rows.length,
    scored: 0,
    skippedNoEntryPrice: 0,
    skippedNoVolatility: 0,
    skippedUnscorable: 0,
  };

  for (const bet of rows) {
    const entryPrice =
      bet.entryPrice === null ? await closeAsOf(bet.ticker, bet.createdAt) : Number(bet.entryPrice);
    if (entryPrice === null) {
      result.skippedNoEntryPrice += 1;
      continue;
    }

    const volatility =
      bet.volatilityAtEntry === null
        ? volatilityFromCloses(await trailingCloses(bet.ticker, bet.createdAt))
        : Number(bet.volatilityAtEntry);
    if (volatility === null) {
      result.skippedNoVolatility += 1;
      continue;
    }

    const scored = calculateYoloScore({
      entryPrice,
      targetPrice: Number(bet.targetPrice),
      createdAt: bet.createdAt,
      expiresAt: bet.expiresAt,
      volatilityAtEntry: volatility,
      // `expired` is the banbet vocabulary for "deadline passed, target never
      // reached" — the same thing a YoloBet calls `lost`.
      outcome: bet.status === "won" ? "won" : "lost",
    });

    if (!scored.scorable) {
      result.skippedUnscorable += 1;
      continue;
    }

    await prisma.wsbBanbets.update({
      where: { id: bet.id },
      data: {
        entryPrice,
        volatilityAtEntry: volatility,
        targetMove: scored.targetMove,
        expectedMove: scored.expectedMove,
        difficulty: scored.difficulty,
        rawScore: scored.rawScore,
        scoreDelta: scored.scoreDelta,
        scoringVersion: scored.scoringVersion,
      },
    });
    result.scored += 1;
  }

  return result;
}
