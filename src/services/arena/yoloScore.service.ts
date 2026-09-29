import {
  SECONDS_PER_YEAR,
  YOLO_SCORE_CONFIG,
  YOLO_SCORING_VERSION,
} from "./yoloScore.config.js";

/**
 * YOLO SCORE — the one implementation. The backend is the authority.
 *
 * THE QUESTION IT ANSWERS is not "was this user right?" — win rate already
 * answers that — but "how hard was the call they got right?". A +5% target on
 * META over 30 days and a +50% target on META over 30 days are both a win if
 * they land, and treating them alike is what makes a leaderboard meaningless.
 *
 * Three things make a prediction hard, and all three are priced in:
 *
 *   1. DISTANCE. How far the target sits from entry.
 *   2. TIME. How little of it the market is given to get there.
 *   3. VOLATILITY. How unusual that distance is FOR THIS ASSET. +10% on SPY is
 *      an extraordinary claim; +10% on a small cap that routinely swings 8% in
 *      a day is close to a coin flip. Without this the score would just reward
 *      betting on whatever moves most.
 *
 * Two deliberate choices worth knowing:
 *
 *   - Distance is a LOG return, abs(ln(target/entry)), not (target-entry)/entry.
 *     A halving and a doubling are the same size of claim; simple percentages
 *     call one 50 and the other 100, which would make DOWN bets structurally
 *     cheaper than UP bets and quietly bias the whole board bullish.
 *
 *   - Volatility is the value observed AT CREATION and frozen onto the bet.
 *     Scoring a call with volatility measured afterwards would let the very
 *     move being predicted change the difficulty of predicting it.
 *
 * This module is PURE: no clock, no database, no network. Everything it needs
 * arrives as arguments, which is what makes the formula testable and lets the
 * frontend preview and the stored value be provably the same number.
 */

export type BetDirection = "up" | "down";

/** The three states a bet can be scored in. */
export type ScoredOutcome = "won" | "lost" | "unresolved";

export interface YoloScoreInput {
  entryPrice: number;
  targetPrice: number;
  /** When the bet was placed. */
  createdAt: Date;
  /** When it stops being winnable. */
  expiresAt: Date;
  /**
   * Annualized realized volatility as a DECIMAL (0.4 = 40%), measured at
   * creation. Null when no price history supports a figure — see
   * `ScoreUnavailableReason`.
   */
  volatilityAtEntry: number | null;
  /** "unresolved" scores the bet's potential; the delta is then 0. */
  outcome: ScoredOutcome;
}

export interface YoloScoreBreakdown {
  /** abs(ln(target/entry)) — symmetric between UP and DOWN. */
  targetMove: number;
  /** sigma * sqrt(T) — what this asset normally does over this horizon. */
  expectedMove: number;
  /** targetMove / expectedMove. 1 = an ordinary move, 5 = a wild claim. */
  difficulty: number;
  /** What a win pays, after the exponent and the cap. */
  rawScore: number;
  /** What the leaderboard adds: +raw on a win, -raw*k on a loss, 0 unresolved. */
  scoreDelta: number;
  /** True when the cap bit, so the UI can say so rather than imply coincidence. */
  capped: boolean;
  scoringVersion: string;
}

/** Why a bet could not be scored. Never guessed around. */
export type ScoreUnavailableReason =
  | "missing_volatility"
  | "invalid_prices"
  | "invalid_window"
  | "no_move";

export interface YoloScoreUnavailable {
  scorable: false;
  reason: ScoreUnavailableReason;
}

export type YoloScoreResult = (YoloScoreBreakdown & { scorable: true }) | YoloScoreUnavailable;

const unavailable = (reason: ScoreUnavailableReason): YoloScoreUnavailable => ({
  scorable: false,
  reason,
});

/** Six dp — enough to audit, short enough to store and compare. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Scores are points, to the cent. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The horizon in years. Fractional by design: a 7-day bet is 0.0192 years, and
 * the square root of that is what makes a week's expected move a fifth of a
 * year's rather than a fifty-second of it.
 */
export function horizonYears(createdAt: Date, expiresAt: Date): number {
  const seconds = (expiresAt.getTime() - createdAt.getTime()) / 1000;
  return seconds / SECONDS_PER_YEAR;
}

/** What this asset normally does over this horizon, under sqrt-time scaling. */
export function expectedMoveFor(volatility: number, years: number): number {
  return volatility * Math.sqrt(years);
}

/**
 * THE CALCULATION.
 *
 * Returns a breakdown rather than a number: every component is stored on the
 * bet, so a score can be audited years later and a future formula can be
 * compared against this one instead of quietly replacing it.
 */
export function calculateYoloScore(input: YoloScoreInput): YoloScoreResult {
  const { entryPrice, targetPrice, createdAt, expiresAt, volatilityAtEntry, outcome } = input;

  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(targetPrice) ||
    entryPrice <= 0 ||
    targetPrice <= 0
  ) {
    return unavailable("invalid_prices");
  }

  const years = horizonYears(createdAt, expiresAt);
  if (!Number.isFinite(years) || years <= 0) return unavailable("invalid_window");

  // NO VOLATILITY, NO SCORE. Substituting a market-wide average would quietly
  // assert that this ticker behaves like the index, which is the very claim the
  // score exists to test. Callers surface N/A instead.
  if (volatilityAtEntry === null || !Number.isFinite(volatilityAtEntry) || volatilityAtEntry <= 0) {
    return unavailable("missing_volatility");
  }

  const targetMove = Math.abs(Math.log(targetPrice / entryPrice));
  if (targetMove <= 0) return unavailable("no_move");

  const expectedMove = expectedMoveFor(volatilityAtEntry, years);
  if (!Number.isFinite(expectedMove) || expectedMove <= 0) {
    return unavailable("missing_volatility");
  }

  const difficulty = targetMove / expectedMove;

  const uncapped = 100 * Math.pow(difficulty, YOLO_SCORE_CONFIG.difficultyExponent);
  const capped = uncapped > YOLO_SCORE_CONFIG.maxPerBet;
  const rawScore = capped ? YOLO_SCORE_CONFIG.maxPerBet : uncapped;

  // A loss costs a FRACTION of what the win would have paid — that bet's own
  // stake, not a flat fee, so difficulty cuts both ways.
  const scoreDelta =
    outcome === "won"
      ? rawScore
      : outcome === "lost"
        ? -rawScore * YOLO_SCORE_CONFIG.lossMultiplier
        : 0;

  return {
    scorable: true,
    targetMove: round6(targetMove),
    expectedMove: round6(expectedMove),
    difficulty: round6(difficulty),
    rawScore: round2(rawScore),
    scoreDelta: round2(scoreDelta),
    capped,
    scoringVersion: YOLO_SCORING_VERSION,
  };
}

/**
 * Does a target clear the triviality floor?
 *
 * Separate from the score because it is a VALIDATION question, not a scoring
 * one: "SPY to +0.01%" is not a cheap bet, it is not a bet.
 */
export function meetsMinimumTargetMove(entryPrice: number, targetPrice: number): boolean {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;
  const movePercent = Math.abs((targetPrice - entryPrice) / entryPrice) * 100;
  return movePercent >= YOLO_SCORE_CONFIG.minTargetMovePercent;
}

/** The direction a target implies, so it is never taken on trust from a client. */
export function directionFor(entryPrice: number, targetPrice: number): BetDirection {
  return targetPrice >= entryPrice ? "up" : "down";
}

/**
 * Was the target TOUCHED during a bar?
 *
 * Touch, not close. A call that reaches $850.01 intraday and settles at $840
 * was right, and judging it on the close would mark it wrong for a reason its
 * author never claimed anything about.
 */
export function targetTouched(
  direction: BetDirection,
  targetPrice: number,
  bar: { high: number | null; low: number | null },
): boolean {
  if (direction === "up") return bar.high !== null && bar.high >= targetPrice;
  return bar.low !== null && bar.low <= targetPrice;
}
