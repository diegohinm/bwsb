import { prisma } from "../../lib/prisma.js";
import { calculateYoloScore, targetTouched, type BetDirection } from "./yoloScore.service.js";

/**
 * BET RESOLUTION — did the price ever reach the target before the deadline?
 *
 * TOUCH, NOT CLOSE. A call for $850 that prints $850.01 at 10:14 and settles at
 * $840 was right: the author claimed the price would get there, not that it
 * would stay. Resolving on the closing price would mark that call wrong for a
 * reason nobody ever bet on. So every bar in the window is examined and the
 * high (for UP) or the low (for DOWN) decides.
 *
 * BARS, NOT POLLED QUOTES. Sampling a live quote every minute would miss any
 * touch between samples and would make the outcome depend on worker uptime.
 * Stored candles are a complete record of the window, so a bet resolves the
 * same way whenever it is evaluated — which also makes re-running the resolver
 * idempotent rather than a second opinion.
 *
 * The resolver never reaches a provider. It reads `market_candles`, which the
 * market-data worker fills; a gap in those bars is reported as a gap, not
 * silently treated as "never touched".
 */

/** Bar widths we will resolve against, finest first. */
const PREFERRED_INTERVALS = ["1m", "5m", "15m", "1h", "1d"] as const;

export interface ResolutionBar {
  timestamp: Date;
  high: number | null;
  low: number | null;
  close: number | null;
}

export type ResolutionOutcome =
  | { status: "won"; resolvedAt: Date; resultPrice: number; interval: string }
  | { status: "lost"; resolvedAt: Date; resultPrice: number | null; interval: string }
  | { status: "active" }
  | { status: "unresolvable"; reason: "no_bars" };

/**
 * Walk the window in time order and stop at the first touch.
 *
 * PURE — the bars arrive as an argument so this is testable without a
 * database, and so the backfill and the live worker provably agree.
 */
export function resolveAgainstBars(
  direction: BetDirection,
  targetPrice: number,
  expiresAt: Date,
  now: Date,
  bars: ResolutionBar[],
  interval: string,
): ResolutionOutcome {
  const ordered = [...bars].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  for (const bar of ordered) {
    // A bar that opens at or after the deadline is outside the window. Its
    // high may well clear the target — a day late.
    if (bar.timestamp >= expiresAt) break;
    if (targetTouched(direction, targetPrice, bar)) {
      return {
        status: "won",
        resolvedAt: bar.timestamp,
        resultPrice: direction === "up" ? bar.high! : bar.low!,
        interval,
      };
    }
  }

  // Not touched yet. Still running until the deadline passes.
  if (now < expiresAt) return { status: "active" };

  // The deadline has passed with no touch. Only call that a loss if we
  // actually saw bars covering the window — with none, "never touched" is an
  // absence of evidence, not evidence of absence.
  const inWindow = ordered.filter((b) => b.timestamp < expiresAt);
  if (inWindow.length === 0) return { status: "unresolvable", reason: "no_bars" };

  const last = inWindow[inWindow.length - 1]!;
  return {
    status: "lost",
    resolvedAt: expiresAt,
    resultPrice: last.close,
    interval,
  };
}

/**
 * Load the finest bars available for a window.
 *
 * Minutes where we have them, falling back through coarser widths. A daily bar
 * still carries a true high and low, so it resolves a touch correctly — it just
 * dates the touch to the day rather than the minute.
 */
export async function loadResolutionBars(
  ticker: string,
  from: Date,
  to: Date,
): Promise<{ bars: ResolutionBar[]; interval: string } | null> {
  for (const interval of PREFERRED_INTERVALS) {
    const rows = await prisma.marketCandle.findMany({
      where: { ticker: ticker.toUpperCase(), interval, timestamp: { gte: from, lt: to } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, high: true, low: true, close: true },
    });
    if (rows.length === 0) continue;
    return {
      interval,
      bars: rows.map((r) => ({
        timestamp: r.timestamp,
        high: r.high === null ? null : Number(r.high),
        low: r.low === null ? null : Number(r.low),
        close: r.close === null ? null : Number(r.close),
      })),
    };
  }
  return null;
}

export interface ResolveSweepResult {
  examined: number;
  won: number;
  lost: number;
  stillActive: number;
  unresolvable: number;
}

/**
 * Resolve every YoloBet that can be resolved.
 *
 * Worker-side. Scoring happens HERE and not at creation, because `scoreDelta`
 * depends on the outcome; the difficulty components were frozen when the bet
 * was placed and are only re-stamped, never recomputed from today's volatility.
 */
export async function resolveDueYoloBets(now: Date = new Date()): Promise<ResolveSweepResult> {
  const open = await prisma.yoloBets.findMany({
    where: { status: "active" },
    orderBy: { expiresAt: "asc" },
    take: 500,
  });

  const result: ResolveSweepResult = {
    examined: open.length,
    won: 0,
    lost: 0,
    stillActive: 0,
    unresolvable: 0,
  };

  for (const bet of open) {
    const loaded = await loadResolutionBars(bet.ticker, bet.entryTimestamp, bet.expiresAt);
    if (!loaded) {
      if (now >= bet.expiresAt) result.unresolvable += 1;
      else result.stillActive += 1;
      continue;
    }

    const outcome = resolveAgainstBars(
      bet.direction as BetDirection,
      Number(bet.targetPrice),
      bet.expiresAt,
      now,
      loaded.bars,
      loaded.interval,
    );

    if (outcome.status === "active") {
      result.stillActive += 1;
      continue;
    }
    if (outcome.status === "unresolvable") {
      result.unresolvable += 1;
      continue;
    }

    // The frozen volatility, not today's. See realizedVolatility.service.
    const scored = calculateYoloScore({
      entryPrice: Number(bet.entryPrice),
      targetPrice: Number(bet.targetPrice),
      createdAt: bet.entryTimestamp,
      expiresAt: bet.expiresAt,
      volatilityAtEntry: bet.volatilityAtEntry === null ? null : Number(bet.volatilityAtEntry),
      outcome: outcome.status,
    });

    await prisma.yoloBets.update({
      where: { id: bet.id },
      data: {
        status: outcome.status,
        resolvedAt: outcome.resolvedAt,
        resultPrice: outcome.resultPrice,
        ...(scored.scorable
          ? {
              targetMove: scored.targetMove,
              expectedMove: scored.expectedMove,
              difficulty: scored.difficulty,
              rawScore: scored.rawScore,
              scoreDelta: scored.scoreDelta,
              scoringVersion: scored.scoringVersion,
            }
          : {}),
      },
    });

    if (outcome.status === "won") result.won += 1;
    else result.lost += 1;
  }

  return result;
}
