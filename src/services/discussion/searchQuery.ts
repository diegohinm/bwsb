/**
 * Normalizing what a reader typed into the search box.
 *
 * THE PROBLEM THIS SOLVES: "UBER" found results and "$UBER" found none. People
 * write cashtags — it is how tickers are written on Reddit — and the search was
 * matching the literal string, so the dollar sign turned a working query into a
 * dead one.
 *
 * NORMALIZED HERE, IN THE BACKEND. Stripping the `$` inside an input component
 * would fix the box and leave the API broken: `GET /api/discussion?q=$UBER`
 * still has to work when called directly.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: strip `$` from everything. `$100` is money,
 * not a security, and turning it into a ticker search for "100" would return
 * nonsense. A cashtag candidate has to look like a symbol AND be one.
 */

/** `$` followed by 1–5 letters, as a whole word. `$100` never matches. */
const CASHTAG = /(?<![A-Za-z0-9])\$([A-Za-z]{1,5})(?![A-Za-z0-9])/g;

export type NormalizedSearch = {
  /** Exactly what the reader typed. */
  raw: string;
  /**
   * The text with validated cashtags reduced to bare symbols, so a free-text
   * match can find "UBER" in a body that never wrote the dollar sign.
   */
  normalizedText: string;
  /** Catalog-validated symbols the query explicitly named. */
  tickerSymbols: string[];
};

/**
 * Split a query into text and the tickers it names.
 *
 * @param isKnownSymbol decides whether a cashtag candidate is a real security.
 *        Injected rather than imported so this stays pure and testable, and so
 *        the catalog is read once per request rather than once per token.
 *
 * Only VALIDATED cashtags are rewritten. `$CEO`, `$USD` and `$IPO` look like
 * symbols but are not securities, so they are left in the text exactly as
 * typed — someone searching for them meant the words.
 */
export function normalizeSearchQuery(
  raw: string,
  isKnownSymbol: (symbol: string) => boolean,
): NormalizedSearch {
  const input = raw ?? "";
  const symbols: string[] = [];

  const normalizedText = input.replace(CASHTAG, (match, candidate: string) => {
    const symbol = candidate.toUpperCase();
    if (!isKnownSymbol(symbol)) return match; // not a security — leave it alone
    if (!symbols.includes(symbol)) symbols.push(symbol);
    return symbol;
  });

  return { raw: input, normalizedText, tickerSymbols: symbols };
}

/**
 * The terms a query should be matched against.
 *
 * Both the raw text and the normalized text are searched, because a post may
 * have written it either way: "$UBER to the moon" and "UBER to the moon" are
 * the same query as far as the reader is concerned, and each string finds
 * content the other misses.
 */
export function searchTerms(normalized: NormalizedSearch): string[] {
  const terms = new Set<string>();
  const raw = normalized.raw.trim();
  const text = normalized.normalizedText.trim();
  if (raw) terms.add(raw);
  if (text) terms.add(text);
  return [...terms];
}
