/**
 * earlyLateScore.service.ts
 *
 * Classifies the timing quality of a bet's entry relative to the underlying
 * price move and implied volatility. Rule-based and deterministic: a lower
 * score means the entry looks late/chasing; a higher score means it was early.
 */

export type BetTiming =
  | "before_move"
  | "during_breakout"
  | "after_move"
  | "near_local_top"
  | "after_catalyst"
  | "iv_already_inflated";

export interface EarlyLateInput {
  entryPrice: number;
  priceAtEval: number;
  impliedVolatility: number; // e.g. 0.75 for 75%
  hadCatalystBefore: boolean;
}

export interface EarlyLateResult {
  timing: BetTiming;
  score: number; // 0..100, higher = earlier / better timed
  explanation: string;
}

/** Score entry timing using price move % and IV heuristics. */
export function earlyLateScore(input: EarlyLateInput): EarlyLateResult {
  const { entryPrice, priceAtEval, impliedVolatility, hadCatalystBefore } = input;
  const movePct = entryPrice > 0 ? (priceAtEval - entryPrice) / entryPrice : 0;

  let timing: BetTiming;
  let score: number;
  let explanation: string;

  if (impliedVolatility >= 1.0) {
    timing = "iv_already_inflated";
    score = 20;
    explanation = "Entered when implied volatility was already very high; premium was expensive.";
  } else if (hadCatalystBefore) {
    timing = "after_catalyst";
    score = 30;
    explanation = "Entry followed a known catalyst, so much of the move may have been priced in.";
  } else if (movePct <= -0.05) {
    timing = "before_move";
    score = 85;
    explanation = "Entered before the up-move materialized (price rose after entry).";
  } else if (movePct < 0.1) {
    timing = "during_breakout";
    score = 65;
    explanation = "Entered while the breakout was underway.";
  } else if (movePct < 0.3) {
    timing = "after_move";
    score = 40;
    explanation = "Entered after a meaningful move had already occurred.";
  } else {
    timing = "near_local_top";
    score = 15;
    explanation = "Entered after an outsized run, near a likely local top.";
  }

  return { timing, score, explanation };
}
