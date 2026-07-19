/**
 * betExtractor.service.ts
 *
 * Deterministic, rule-based extraction of options bets from free text. This is
 * the baseline for the differentiated "exact extraction of bets" feature; an
 * ML/LLM extractor can later implement the same BetCandidate interface.
 *
 * Supported patterns (case-insensitive):
 *   "$RDDT 180c 8/21"
 *   "RDDT calls 180 08/21"
 *   "10 POET 7.5p exp 8/21 paid 1.20"
 *   "bought 5 RDDT calls strike 180 exp Aug 21 premium 4.20"
 */

import type {
  Direction,
  Instrument,
  Moneyness,
  OptionType,
  PositionIntent,
} from "../../types/domain.js";

export interface BetCandidate {
  ticker: string;
  instrument: Instrument;
  optionType: OptionType | null;
  direction: Direction;
  strike: number | null;
  expiration: string | null; // ISO date
  contracts: number | null;
  premium: number | null;
  declaredCapital: number | null;
  dte: number | null;
  moneyness: Moneyness;
  positionIntent: PositionIntent;
  extractionConfidence: number;
  rawEvidence: { text: string; matched: string };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse assorted date shapes into an ISO date string (YYYY-MM-DD). */
function parseExpiration(raw: string, now: Date): string | null {
  const trimmed = raw.trim().toLowerCase();

  // Numeric M/D or M/D/YY(YY)
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : now.getUTCFullYear();
    if (year < 100) year += 2000;
    const iso = toIso(year, month, day);
    // If the date already passed this year and no year was given, roll forward.
    if (!slash[3] && iso && new Date(iso) < now) return toIso(year + 1, month, day);
    return iso;
  }

  // "Aug 21" or "aug 21 2026"
  const named = trimmed.match(/^([a-z]{3,4})\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (named) {
    const month = MONTHS[named[1]!];
    if (!month) return null;
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : now.getUTCFullYear();
    const iso = toIso(year, month, day);
    if (!named[3] && iso && new Date(iso) < now) return toIso(year + 1, month, day);
    return iso;
  }

  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function classifyIntent(text: string): PositionIntent {
  const t = text.toLowerCase();
  if (/\b(sold|closed|took profit|cut)\b/.test(t)) return "closed_position";
  if (/\b(should i|thoughts\?|worth it\?)\b/.test(t)) return "question";
  if (/\b(lol|lmao|meme|jk|sarcasm|\/s)\b/.test(t)) return "meme";
  if (/\b(thinking|might buy|watching|considering|planning)\b/.test(t)) return "future_intent";
  if (/\b(bought|holding|my position|yolo|in at|entered|loaded)\b/.test(t)) return "real_position";
  if (/\b(should|would|if )\b/.test(t)) return "hypothesis";
  return "unverified";
}

const CONTRACTS_RE = /(?:bought|buy|grabbed|got|loaded)?\s*(\d{1,4})\s+(?:contracts?\s+of\s+)?/i;
const PREMIUM_RE = /(?:premium|paid|@|for|cost)\s*\$?(\d+(?:\.\d+)?)/i;

/**
 * Extract every bet candidate found in the text. `knownTickers` scopes matches
 * to real symbols; `now` is injected for deterministic DTE math in tests.
 */
export function extractBets(
  text: string,
  knownTickers: string[],
  now: Date = new Date(),
): BetCandidate[] {
  const tickerAlt = knownTickers.map((t) => t.toUpperCase()).join("|");
  if (!tickerAlt) return [];

  // Two broad shapes:
  //  A) TICKER <strike>c/p <exp>     e.g. RDDT 180c 8/21   |  RDDT 7.5p exp 8/21
  //  B) TICKER calls|puts <strike> <exp>   e.g. RDDT calls 180 08/21
  const patternA = new RegExp(
    `\\$?(${tickerAlt})\\s+(\\d+(?:\\.\\d+)?)\\s*([cp])\\b(?:.*?(?:exp\\.?\\s*)?((?:\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)|(?:[A-Za-z]{3,4}\\s+\\d{1,2}(?:\\s+\\d{4})?)))?`,
    "gi",
  );
  const patternB = new RegExp(
    `\\$?(${tickerAlt})\\s+(calls?|puts?)\\s+(?:strike\\s+)?(\\d+(?:\\.\\d+)?)(?:.*?(?:exp\\.?\\s*)?((?:\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)|(?:[A-Za-z]{3,4}\\s+\\d{1,2}(?:\\s+\\d{4})?)))?`,
    "gi",
  );

  const candidates: BetCandidate[] = [];
  const seen = new Set<string>();

  const push = (
    ticker: string,
    optionType: OptionType,
    strike: number,
    expRaw: string | undefined,
    matched: string,
  ) => {
    const key = `${ticker}:${optionType}:${strike}:${expRaw ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);

    const expiration = expRaw ? parseExpiration(expRaw, now) : null;
    const contracts = numberFrom(text, CONTRACTS_RE);
    const premium = numberFrom(text, PREMIUM_RE);
    const declaredCapital =
      contracts != null && premium != null
        ? Math.round(contracts * premium * 100 * 100) / 100
        : null;
    const dte = expiration
      ? Math.max(0, Math.round((new Date(expiration).getTime() - now.getTime()) / 86400000))
      : null;
    const direction: Direction = optionType === "call" ? "bullish" : "bearish";

    // Confidence grows with how many fields we resolved.
    let confidence = 0.4;
    if (expiration) confidence += 0.2;
    if (contracts != null) confidence += 0.2;
    if (premium != null) confidence += 0.2;

    candidates.push({
      ticker: ticker.toUpperCase(),
      instrument: "option",
      optionType,
      direction,
      strike,
      expiration,
      contracts,
      premium,
      declaredCapital,
      dte,
      moneyness: "unknown",
      positionIntent: classifyIntent(text),
      extractionConfidence: Math.round(confidence * 100) / 100,
      rawEvidence: { text, matched },
    });
  };

  for (const m of text.matchAll(patternA)) {
    const optionType: OptionType = m[3]!.toLowerCase() === "c" ? "call" : "put";
    push(m[1]!, optionType, Number(m[2]), m[4], m[0]!);
  }
  for (const m of text.matchAll(patternB)) {
    const optionType: OptionType = m[2]!.toLowerCase().startsWith("call") ? "call" : "put";
    push(m[1]!, optionType, Number(m[3]), m[4], m[0]!);
  }

  return candidates;
}

function numberFrom(text: string, re: RegExp): number | null {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}
