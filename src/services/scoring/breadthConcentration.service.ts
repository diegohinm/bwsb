/**
 * breadthConcentration.service.ts
 *
 * Conversation breadth vs concentration. Includes a reusable Gini coefficient
 * utility. A high Gini means attention is concentrated in a few tickers
 * (narrow breadth); a low Gini means attention is spread out (broad breadth).
 */

/** Gini coefficient (0 = perfectly equal, 1 = fully concentrated). */
export function gini(values: number[]): number {
  const xs = values.filter((v) => v >= 0);
  const n = xs.length;
  if (n === 0) return 0;
  const total = xs.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  const sorted = [...xs].sort((a, b) => a - b);
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    cumulative += (2 * (i + 1) - n - 1) * sorted[i]!;
  }
  return Math.round((cumulative / (n * total)) * 1000) / 1000;
}

export interface BreadthResult {
  tickers: number;
  total_mentions: number;
  concentration_gini: number;
  breadth_score: number; // 0-100, higher = broader participation
  top_share: number; // share of mentions held by the single top ticker
}

/** Compute breadth/concentration from per-ticker mention counts. */
export function computeBreadth(
  rows: Array<{ ticker: string; mentions: number }>,
): BreadthResult {
  const mentions = rows.map((r) => Number(r.mentions) || 0);
  const total = mentions.reduce((a, b) => a + b, 0);
  const g = gini(mentions);
  const top = mentions.length ? Math.max(...mentions) : 0;

  return {
    tickers: rows.length,
    total_mentions: total,
    concentration_gini: g,
    breadth_score: Math.round((1 - g) * 100),
    top_share: total > 0 ? Math.round((top / total) * 1000) / 1000 : 0,
  };
}
