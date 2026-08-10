/**
 * Which symbols are too easily confused with ordinary language.
 *
 * THE ONE PLACE this is decided. The catalog refresh writes the result to
 * `tickers.is_ambiguous`, and the Reddit detector reads it back; nothing else
 * derives ambiguity, and nothing here interprets text.
 *
 * WHAT AMBIGUOUS DOES AND DOES NOT MEAN
 *
 * It does NOT mean the security is invalid. Agilent (`A`), SentinelOne (`S`)
 * and Unity (`U`) are real companies and stay in the catalog. It means a BARE
 * mention of the symbol is not evidence that anyone was talking about the
 * security — only an explicit `$A` is.
 *
 * WHY THE SINGLE-LETTER RULE IS DERIVED, NOT LISTED
 *
 * Every one-character symbol is ambiguous by construction: a single capital
 * letter appears in ordinary prose constantly, and no list could keep up with
 * the exchanges issuing them. Deriving it from length means a symbol that
 * lists tomorrow is handled the day it arrives, with no one having to notice.
 *
 * This was not theoretical. With the full US catalog loaded, the 24-hour Top
 * Tickers ranking came out as `S`, `A`, `GOOGL`, `U`, `P` — four of the top
 * five were letters harvested from capitalised prose.
 */

/**
 * Multi-character symbols that are also everyday words.
 *
 * Hand-reviewed, because there is no property of the string that separates
 * "IT" the pronoun from "IT" the Gartner ticker. Kept deliberately short: each
 * entry costs real mentions of a real company, so it should be added only when
 * the false positives are worse than the misses.
 */
export const MANUAL_AMBIGUOUS_TICKERS: ReadonlySet<string> = new Set([
  // The original three.
  "AI", // C3.ai — the field
  "ON", // ON Semiconductor — the preposition
  "IT", // Gartner — the pronoun

  // EVERY ENTRY BELOW WAS VERIFIED AGAINST THE CATALOG before being added:
  // each one is an ACTIVE listed symbol that is also an everyday English word.
  // Words that are not listed symbols are deliberately absent — the detector
  // already refuses anything outside the catalog, so listing them here would
  // imply a check that does nothing. A first draft of this set carried 31 such
  // words ("THE", "BUY", "WORK", …) and they were removed once measured.
  //
  // Pronouns, articles, prepositions, conjunctions.
  "AN", "ANY", "ARE", "AS", "BE", "FOR", "HAS", "HE", "SO", "TWO", "UP", "YOU",
  // Verbs.
  "EAT", "EDIT", "FLY", "GO", "LIVE", "LOVE", "MOVE", "OPEN", "PAY", "PLAY",
  "RUN", "TALK",
  // Adjectives and adverbs.
  "ALL", "EVER", "FAST", "GOOD", "LOW", "NEXT", "NICE", "ODD", "OUT", "PLUS",
  "REAL", "SAFE", "WELL",
  // Ordinary nouns.
  "CAR", "CASH", "FUN", "HOPE", "JOB", "KEY", "LAND", "LIFE", "LOAN", "MAN",
  "NOW", "STEP", "SUN", "TREE",
  // Reddit shorthand that collides with a symbol: "DD" is DuPont, but on
  // r/wallstreetbets it is due diligence in nearly every occurrence.
  "DD",
]);

/** Symbols of this length are ambiguous automatically. */
export const AMBIGUOUS_SYMBOL_LENGTH = 1;

/**
 * Is a bare mention of this symbol untrustworthy?
 *
 * `isAmbiguous = symbol.length === 1 OR MANUAL_AMBIGUOUS_TICKERS.has(symbol)`
 */
export function isAmbiguousTicker(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.length === 0) return false;
  return (
    normalized.length === AMBIGUOUS_SYMBOL_LENGTH || MANUAL_AMBIGUOUS_TICKERS.has(normalized)
  );
}

/**
 * Back-compat export for callers that only need the manual set.
 *
 * @deprecated Use {@link isAmbiguousTicker}: reading the set alone misses every
 * single-letter symbol, which is the larger half of the rule.
 */
export const AMBIGUOUS_TICKER_SYMBOLS = MANUAL_AMBIGUOUS_TICKERS;
