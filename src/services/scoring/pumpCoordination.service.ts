/**
 * pumpCoordination.service.ts
 *
 * Scores the likelihood that ticker chatter reflects coordinated pumping rather
 * than organic interest. Operates only on anonymized aggregate signals (never
 * individuals): repeated phrasing, author concentration, new-account ratio,
 * deletion rate, and cross-subreddit spread. Deterministic weighted blend.
 */

export interface PumpCoordinationInput {
  repeatedPhrases: string[]; // distinct phrases repeated across posts
  authorConcentration: number; // 0..1, share of activity from few authors
  newAccountRatio: number; // 0..1, share of new/low-age accounts
  deletionRate: number; // 0..1, share of posts later deleted
  crossSubreddit: number; // 0..1, coordinated spread across subreddits
}

export interface PumpCoordinationResult {
  score: number; // 0..100
  severity: "low" | "medium" | "high";
  explanation: string;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isNaN(n) ? 0 : n));
}

/** Blend anonymized coordination signals into a 0..100 pump score. */
export function pumpCoordinationScore(input: PumpCoordinationInput): PumpCoordinationResult {
  const phraseSignal = clamp01(input.repeatedPhrases.length / 10);
  const concentration = clamp01(input.authorConcentration);
  const newAccounts = clamp01(input.newAccountRatio);
  const deletions = clamp01(input.deletionRate);
  const cross = clamp01(input.crossSubreddit);

  const weighted =
    phraseSignal * 0.25 +
    concentration * 0.25 +
    newAccounts * 0.2 +
    deletions * 0.15 +
    cross * 0.15;

  const score = Math.round(weighted * 100);
  const severity: PumpCoordinationResult["severity"] =
    score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  const explanation =
    `Coordination score ${score}/100 (${severity}) from repeated phrasing, ` +
    `author concentration, new-account ratio, deletion rate, and cross-subreddit spread. ` +
    `Based on anonymized aggregates only.`;

  return { score, severity, explanation };
}
