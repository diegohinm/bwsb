/**
 * stanceClassifier.service.ts
 *
 * Rule-based bullish / bearish / neutral / unknown stance on the UNDERLYING.
 *
 * Options context matters: a put "getting destroyed" is bullish for the
 * underlying, and a call "getting destroyed" is bearish. Buying calls is
 * bullish; buying puts is bearish.
 */

import type { Direction } from "../../types/domain.js";

export interface StanceResult {
  stance: Direction;
  confidence: number;
  matchedTerms: string[];
}

const BULLISH_TERMS = [
  "moon","rocket","calls","buying calls","bought calls","long","bullish","breakout",
  "squeeze","undervalued","buy","loading up","diamond hands","hold","printing","tendies",
];
const BEARISH_TERMS = [
  "puts","buying puts","bought puts","short","bearish","overvalued","dump","crash",
  "sell","bagholder","rug","drilling","bear","downtrend",
];

// Options-context overrides: "<option> got destroyed/wrecked/crushed".
const DESTROYED_RE = /\b(calls?|puts?)\b[^.!?]{0,20}\b(destroyed|wrecked|crushed|printed|mooned)\b/gi;

export function classifyStance(text: string): StanceResult {
  const lower = ` ${text.toLowerCase()} `;
  const matched: string[] = [];
  let score = 0;

  for (const term of BULLISH_TERMS) {
    if (lower.includes(` ${term} `) || lower.includes(term)) {
      score += 1;
      matched.push(term);
    }
  }
  for (const term of BEARISH_TERMS) {
    if (lower.includes(` ${term} `) || lower.includes(term)) {
      score -= 1;
      matched.push(term);
    }
  }

  // Options-context overrides can flip the naive keyword tally.
  for (const m of text.matchAll(DESTROYED_RE)) {
    const instrument = m[1]!.toLowerCase();
    const verb = m[2]!.toLowerCase();
    const negative = ["destroyed", "wrecked", "crushed"].includes(verb);
    const positive = ["printed", "mooned"].includes(verb);
    if (instrument.startsWith("put")) {
      score += negative ? 2 : positive ? -2 : 0; // puts down => bullish underlying
    } else {
      score += negative ? -2 : positive ? 2 : 0; // calls down => bearish underlying
    }
    matched.push(`${instrument} ${verb}`);
  }

  const magnitude = Math.min(1, Math.abs(score) / 4);
  if (score > 0) return { stance: "bullish", confidence: round(0.5 + magnitude / 2), matchedTerms: matched };
  if (score < 0) return { stance: "bearish", confidence: round(0.5 + magnitude / 2), matchedTerms: matched };
  if (matched.length) return { stance: "neutral", confidence: 0.4, matchedTerms: matched };
  return { stance: "unknown", confidence: 0.2, matchedTerms: matched };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
