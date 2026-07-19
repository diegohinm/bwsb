/**
 * contrarianSignal.service.ts
 *
 * Produces a transparent contrarian tilt from a call/put ratio WITHOUT claiming
 * that lopsided positioning is automatically wrong. The tilt grows as stance
 * gets more one-sided, but CONFIDENCE is scaled by sample size, so small
 * samples yield low-confidence signals. All inputs are surfaced as evidence.
 */

export interface ContrarianInput {
  callRatio: number; // 0..1, share of directional positioning that is calls
  sampleSize: number; // number of underlying bets/observations
}

export interface ContrarianEvidence {
  callRatio: number;
  sampleSize: number;
  crowdLean: "bullish" | "bearish" | "balanced";
}

export interface ContrarianResult {
  score: number; // -1..1, negative = contrarian-bearish, positive = contrarian-bullish
  confidence: number; // 0..1, scaled by sample size
  explanation: string;
  evidence: ContrarianEvidence;
}

/** Compute a contrarian tilt with sample-size-scaled confidence. */
export function contrarianSignal(input: ContrarianInput): ContrarianResult {
  const callRatio = Math.max(0, Math.min(1, input.callRatio));
  const sampleSize = Math.max(0, Math.floor(input.sampleSize));

  // Deviation from balanced (0.5). Contrarian tilt opposes the crowd lean.
  const deviation = callRatio - 0.5; // -0.5..0.5
  const score = Math.round(-(deviation * 2) * 1000) / 1000; // crowd bullish -> negative tilt

  // Confidence saturates toward 1 as sample grows (half-saturation at ~50).
  const confidence = Math.round((sampleSize / (sampleSize + 50)) * 1000) / 1000;

  const crowdLean: ContrarianEvidence["crowdLean"] =
    Math.abs(deviation) < 0.1 ? "balanced" : deviation > 0 ? "bullish" : "bearish";

  const explanation =
    `Crowd positioning leans ${crowdLean} (${Math.round(callRatio * 100)}% calls). ` +
    `Contrarian tilt is ${score >= 0 ? "+" : ""}${score}, but confidence is only ${confidence} ` +
    `given a sample of ${sampleSize} observations; treat small samples cautiously.`;

  return {
    score,
    confidence,
    explanation,
    evidence: { callRatio, sampleSize, crowdLean },
  };
}
