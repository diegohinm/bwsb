/**
 * breakoutScoring.service.ts
 *
 * Simple breakout / revival detection based on mention counts. `breakoutScore`
 * measures how concentrated a ticker's lifetime mentions are in the last 7
 * days; `detectRevival` flags tickers that were active, went quiet, then spiked.
 */

/** Share (0..1) of all-time mentions that occurred in the last 7 days. */
export function breakoutScore(mentions7d: number, mentionsAll: number): number {
  const recent = Math.max(0, mentions7d);
  const all = Math.max(0, mentionsAll);
  if (all === 0) return 0;
  return Math.round(Math.min(1, recent / all) * 1000) / 1000;
}

/**
 * True when a ticker had meaningful older activity, went quiet in a middle
 * window, and is now spiking again (a revival rather than a first breakout).
 */
export function detectRevival(
  oldMentions: number,
  recentQuietMentions: number,
  currentMentions: number,
): boolean {
  const old = Math.max(0, oldMentions);
  const quiet = Math.max(0, recentQuietMentions);
  const current = Math.max(0, currentMentions);

  const hadOldActivity = old >= 5;
  const wentQuiet = quiet <= Math.max(1, old * 0.25);
  const isSpiking = current >= Math.max(5, quiet * 3);

  return hadOldActivity && wentQuiet && isSpiking;
}
