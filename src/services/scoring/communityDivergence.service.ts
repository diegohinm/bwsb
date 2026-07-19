/**
 * communityDivergence.service.ts
 *
 * Measures how much different subreddit communities disagree about a ticker.
 * Computes a per-subreddit net stance (-1..1) and an overall divergence score
 * (0..1) derived from the spread of those net stances. Pure and deterministic.
 */

export interface SubredditStance {
  subreddit: string;
  bullish: number;
  bearish: number;
  neutral: number;
}

export interface SubredditNetStance {
  subreddit: string;
  net_stance: number; // -1 (all bearish) .. 1 (all bullish)
  total: number;
}

export interface CommunityDivergenceResult {
  perSubreddit: SubredditNetStance[];
  divergenceScore: number; // 0..1, higher = more disagreement across subs
}

function netStance(row: SubredditStance): SubredditNetStance {
  const bull = Math.max(0, row.bullish);
  const bear = Math.max(0, row.bearish);
  const neut = Math.max(0, row.neutral);
  const total = bull + bear + neut;
  const net = total === 0 ? 0 : (bull - bear) / total;
  return { subreddit: row.subreddit, net_stance: Math.round(net * 1000) / 1000, total };
}

/** Compute per-subreddit net stance and cross-subreddit divergence. */
export function communityDivergence(bySubreddit: SubredditStance[]): CommunityDivergenceResult {
  const perSubreddit = bySubreddit.map(netStance);
  const active = perSubreddit.filter((s) => s.total > 0);

  if (active.length < 2) {
    return { perSubreddit, divergenceScore: 0 };
  }

  const mean = active.reduce((a, s) => a + s.net_stance, 0) / active.length;
  const variance = active.reduce((a, s) => a + (s.net_stance - mean) ** 2, 0) / active.length;
  // net_stance spans [-1,1], so max stddev is 1; use it directly as 0..1 score.
  const divergenceScore = Math.min(1, Math.sqrt(variance));

  return { perSubreddit, divergenceScore: Math.round(divergenceScore * 1000) / 1000 };
}
