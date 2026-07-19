/**
 * tickerExtractor.service.ts
 *
 * Deterministic ticker extraction from free text.
 *  - $CASHTAGS are always extracted ($RDDT).
 *  - Bare UPPERCASE tokens are extracted only if they are in the known-ticker
 *    whitelist, and common English words (is_common_word) are ignored unless
 *    they were prefixed with `$`.
 *
 * The whitelist is passed in so the caller can source it from the DB.
 */

export interface ExtractedTicker {
  ticker: string;
  cashtag: boolean;
  occurrences: number;
}

export interface TickerWhitelistEntry {
  ticker: string;
  isCommonWord: boolean;
}

const CASHTAG_RE = /\$([A-Za-z]{1,6})\b/g;
const BARE_RE = /\b([A-Z]{1,6})\b/g;

export function extractTickers(
  text: string,
  whitelist: TickerWhitelistEntry[],
): ExtractedTicker[] {
  const known = new Map(whitelist.map((w) => [w.ticker.toUpperCase(), w]));
  const found = new Map<string, ExtractedTicker>();

  const bump = (raw: string, cashtag: boolean) => {
    const ticker = raw.toUpperCase();
    const entry = known.get(ticker);
    if (!entry) return;
    // Bare common words (e.g. "AI", "ON") only count when written as a cashtag.
    if (!cashtag && entry.isCommonWord) return;

    const existing = found.get(ticker);
    if (existing) {
      existing.occurrences += 1;
      existing.cashtag = existing.cashtag || cashtag;
    } else {
      found.set(ticker, { ticker, cashtag, occurrences: 1 });
    }
  };

  for (const m of text.matchAll(CASHTAG_RE)) bump(m[1]!, true);
  for (const m of text.matchAll(BARE_RE)) bump(m[1]!, false);

  return [...found.values()].sort((a, b) => b.occurrences - a.occurrences);
}
