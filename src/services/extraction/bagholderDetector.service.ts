/**
 * bagholderDetector.service.ts
 *
 * Rule-based bagholder detection. Looks for loss language, averaging down,
 * "still holding", denial, and a down-percentage. Returns a 0-100 score and the
 * matched patterns.
 */

export interface BagholderResult {
  score: number;
  downPercent: number | null;
  matched: string[];
}

const PATTERNS: Array<[RegExp, number, string]> = [
  [/\baveraging down\b|\baverage down\b|\bavg(ing)? down\b/i, 25, "averaging_down"],
  [/\bstill holding\b|\bnever selling\b|\bcan'?t sell\b/i, 20, "still_holding"],
  [/\bbaghold(er|ing)?\b/i, 25, "bagholding"],
  [/\bdiamond hands\b|\bhodl\b/i, 10, "denial"],
  [/\bthis is fine\b|\bit'?ll come back\b|\bcope\b/i, 15, "denial_language"],
  [/\bdown (?:bad|big|huge)\b/i, 10, "down_language"],
];

const DOWN_PCT_RE = /down\s*(\d{1,3})\s*%/i;

export function detectBagholder(text: string): BagholderResult {
  let score = 0;
  const matched: string[] = [];

  for (const [re, weight, label] of PATTERNS) {
    if (re.test(text)) {
      score += weight;
      matched.push(label);
    }
  }

  const downMatch = text.match(DOWN_PCT_RE);
  const downPercent = downMatch ? Number(downMatch[1]) : null;
  if (downPercent != null) {
    // Bigger losses raise the score.
    score += Math.min(30, Math.round(downPercent / 3));
    matched.push(`down_${downPercent}pct`);
  }

  return { score: Math.min(100, score), downPercent, matched };
}
