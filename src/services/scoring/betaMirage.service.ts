/**
 * betaMirage.service.ts
 *
 * Separates a position's return into idiosyncratic vs market-beta components.
 * The "beta mirage" is the fraction of a raw return that was actually just the
 * broad market (SPY) moving, dressed up as stock-picking skill. Deterministic.
 */

/** Return in excess of what beta exposure to the market would explain. */
export function betaAdjustedReturn(rawReturn: number, spyReturn: number, beta: number): number {
  return rawReturn - beta * spyReturn;
}

/**
 * Fraction (0..1) of the raw return that was explained by market beta rather
 * than idiosyncratic alpha. 1 => the entire move was a mirage; 0 => all alpha.
 */
export function betaMirageScore(rawReturn: number, betaAdjusted: number): number {
  const raw = Math.abs(rawReturn);
  if (raw === 0) return 0;
  const explainedByMarket = raw - Math.abs(betaAdjusted);
  const share = explainedByMarket / raw;
  return Math.round(Math.max(0, Math.min(1, share)) * 1000) / 1000;
}
