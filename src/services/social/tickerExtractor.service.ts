/**
 * Extract stock tickers from free text.
 *
 * Two detection modes:
 *   1. `$`-prefixed cashtags ($NVDA, $RDDT) — always accepted, 1-5 letters.
 *   2. Bare uppercase words — accepted ONLY when on the allowlist, so common
 *      English/finance words (AI, IT, CEO, YOLO…) don't become false tickers.
 *
 * The allowlist is a static MVP set here. If a DB-backed ticker universe is
 * available, pass it via `setTickerAllowlist` at boot so detection widens
 * automatically without touching this file.
 */

/** Static MVP allowlist — overlaps the tickers the UI already surfaces. */
const STATIC_ALLOWLIST = [
  "SPY", "QQQ", "NVDA", "TSLA", "BTC", "GME", "AMC", "HOOD", "RDDT", "PLTR",
  "POET", "SOFI", "MSFT", "AAPL", "META", "AMZN", "NFLX", "AMD", "INTC", "MU",
  "AVGO", "COIN", "MARA", "RIOT",
];

/**
 * Uppercase words that are never tickers on their own, even if they collide
 * with a real symbol. A `$` prefix bypasses this list.
 */
const STOPWORDS = new Set([
  "AI", "ON", "IT", "FOR", "DD", "CEO", "USA", "YOLO", "FOMO", "ETF", "SEC",
  "CEO", "IPO", "USD", "GDP", "EPS", "ATH", "FUD", "IMO", "TLDR", "EOD", "PM",
  "AM", "OTM", "ITM", "PT", "TA", "US", "UK", "EU", "A", "I",
]);

let allowlist = new Set(STATIC_ALLOWLIST);

/** Replace the bare-word allowlist (e.g. with the DB ticker universe). */
export function setTickerAllowlist(tickers: string[]): void {
  allowlist = new Set(
    [...STATIC_ALLOWLIST, ...tickers.map((t) => t.toUpperCase())].filter(
      (t) => t.length >= 1 && t.length <= 5,
    ),
  );
}

const CASHTAG = /\$([A-Za-z]{1,5})\b/g;
const BARE_WORD = /\b([A-Z]{2,5})\b/g;

/** Return unique uppercase tickers found in `text`. */
export function extractTickers(text: string | undefined | null): string[] {
  if (!text) return [];
  const found = new Set<string>();

  for (const m of text.matchAll(CASHTAG)) {
    found.add(m[1].toUpperCase());
  }

  for (const m of text.matchAll(BARE_WORD)) {
    const word = m[1].toUpperCase();
    if (STOPWORDS.has(word)) continue;
    if (allowlist.has(word)) found.add(word);
  }

  return [...found];
}

/** Convenience: extract from several fields at once. */
export function extractTickersFrom(
  ...parts: Array<string | undefined | null>
): string[] {
  const all = new Set<string>();
  for (const part of parts) {
    for (const t of extractTickers(part)) all.add(t);
  }
  return [...all];
}
