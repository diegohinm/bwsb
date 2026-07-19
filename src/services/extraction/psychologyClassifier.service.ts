/**
 * psychologyClassifier.service.ts
 *
 * Rule-based retail-psychology tagging: FOMO, capitulation, herding, echo
 * chamber, despair, euphoria. Returns a 0-100 retail_psychology_score (higher =
 * more emotionally charged / less rational) and the matched tags.
 */

export type PsychologyTag =
  | "fomo"
  | "capitulation"
  | "herding"
  | "echo_chamber"
  | "despair"
  | "euphoria";

export interface PsychologyResult {
  retailPsychologyScore: number;
  tags: PsychologyTag[];
}

const TAG_PATTERNS: Array<[PsychologyTag, RegExp, number]> = [
  ["fomo", /\bfomo\b|\bcan'?t miss\b|\blast chance\b|\bget in now\b/i, 18],
  ["capitulation", /\bgiving up\b|\bsold everything\b|\bcapitulat/i, 20],
  ["herding", /\beveryone (?:is )?buying\b|\bwe all\b|\bapes\b|\bjoin us\b/i, 16],
  ["echo_chamber", /\bonly bulls\b|\bno bears\b|\bif you disagree\b|\bpaper hands leave\b/i, 16],
  ["despair", /\bhopeless\b|\bruined\b|\blost it all\b|\bdespair\b/i, 18],
  ["euphoria", /\bto the moon\b|\bcan'?t lose\b|\bfree money\b|\beasy \d+x\b|\bguaranteed\b/i, 20],
];

export function classifyPsychology(text: string): PsychologyResult {
  let score = 0;
  const tags: PsychologyTag[] = [];

  for (const [tag, re, weight] of TAG_PATTERNS) {
    if (re.test(text)) {
      score += weight;
      tags.push(tag);
    }
  }

  return { retailPsychologyScore: Math.min(100, score), tags };
}
