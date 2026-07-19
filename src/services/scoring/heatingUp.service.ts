/**
 * heatingUp.service.ts
 *
 * Detects tickers whose recent mention rate is running hot relative to their
 * own baseline. Returns the ratio of the last-7-day rate to the 30-day
 * baseline rate plus a boolean flag when it clears a threshold. Deterministic.
 */

export interface HeatingUpResult {
  ratio: number;
  isHeatingUp: boolean;
  threshold: number;
}

/** Compare a short-window rate to a baseline rate. */
export function heatingUpScore(
  last7dRate: number,
  baseline30dRate: number,
  threshold = 1.5,
): HeatingUpResult {
  const recent = Math.max(0, last7dRate);
  const baseline = Math.max(0, baseline30dRate);

  // If there is no baseline, any recent activity counts as heating up.
  const ratio = baseline === 0 ? (recent > 0 ? Infinity : 0) : recent / baseline;
  const rounded = Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : ratio;

  return {
    ratio: rounded,
    isHeatingUp: rounded >= threshold,
    threshold,
  };
}
