import type { Ticker } from "../types/domain.js";

/**
 * Centralized reference catalog of well-known tickers.
 *
 * This is the single source of truth the global search falls back to when the
 * database `tickers` table is empty, unseeded, or unreachable. It guarantees
 * that common symbols (RDDT, NVDA, GME, SPY, …) always resolve so the header
 * search and ticker detail pages work for a logged-out visitor regardless of DB
 * state. Prices/quotes never live here — those come from the MarketDataProvider.
 *
 * Keep this list in sync with the market-data mock universe so search results
 * and ticker pages agree on names.
 */

export type CatalogEntry = {
  ticker: string;
  company_name: string;
  exchange: string;
};

export const TICKER_CATALOG: readonly CatalogEntry[] = [
  { ticker: "RDDT", company_name: "Reddit Inc.", exchange: "NYSE" },
  { ticker: "NVDA", company_name: "NVIDIA Corp.", exchange: "NASDAQ" },
  { ticker: "GME", company_name: "GameStop Corp.", exchange: "NYSE" },
  { ticker: "AMC", company_name: "AMC Entertainment", exchange: "NYSE" },
  { ticker: "TSLA", company_name: "Tesla Inc.", exchange: "NASDAQ" },
  { ticker: "PLTR", company_name: "Palantir Technologies", exchange: "NASDAQ" },
  { ticker: "HOOD", company_name: "Robinhood Markets", exchange: "NASDAQ" },
  { ticker: "SOFI", company_name: "SoFi Technologies", exchange: "NASDAQ" },
  { ticker: "MSFT", company_name: "Microsoft Corp.", exchange: "NASDAQ" },
  { ticker: "AAPL", company_name: "Apple Inc.", exchange: "NASDAQ" },
  { ticker: "META", company_name: "Meta Platforms", exchange: "NASDAQ" },
  { ticker: "AMZN", company_name: "Amazon.com Inc.", exchange: "NASDAQ" },
  { ticker: "GOOGL", company_name: "Alphabet Inc.", exchange: "NASDAQ" },
  { ticker: "NFLX", company_name: "Netflix Inc.", exchange: "NASDAQ" },
  { ticker: "AMD", company_name: "Advanced Micro Devices", exchange: "NASDAQ" },
  { ticker: "INTC", company_name: "Intel Corp.", exchange: "NASDAQ" },
  { ticker: "MU", company_name: "Micron Technology", exchange: "NASDAQ" },
  { ticker: "COIN", company_name: "Coinbase Global", exchange: "NASDAQ" },
  { ticker: "POET", company_name: "POET Technologies", exchange: "NASDAQ" },
  { ticker: "SPY", company_name: "SPDR S&P 500 ETF", exchange: "NYSEARCA" },
  { ticker: "QQQ", company_name: "Invesco QQQ Trust", exchange: "NASDAQ" },
] as const;

const BY_TICKER = new Map<string, CatalogEntry>(
  TICKER_CATALOG.map((e) => [e.ticker, e]),
);

/** Turn a catalog entry into a full Ticker row shape. */
export function catalogEntryToTicker(entry: CatalogEntry): Ticker {
  return {
    ticker: entry.ticker,
    company_name: entry.company_name,
    exchange: entry.exchange,
    is_active: true,
    is_common_word: false,
    created_at: null,
  };
}

/** Exact catalog lookup (case-insensitive). Returns a Ticker row or null. */
export function catalogTicker(symbol: string): Ticker | null {
  const entry = BY_TICKER.get(symbol.toUpperCase());
  return entry ? catalogEntryToTicker(entry) : null;
}

/**
 * Prefix/substring search over the catalog, ranked exact → ticker-prefix →
 * company-contains. Used to backfill DB search results so well-known symbols
 * always appear.
 */
export function searchCatalog(term: string, limit = 8): Ticker[] {
  const q = term.trim().toUpperCase();
  if (!q) return [];

  const scored = TICKER_CATALOG.map((e) => {
    const t = e.ticker.toUpperCase();
    const name = e.company_name.toUpperCase();
    let score = 99;
    if (t === q) score = 0;
    else if (t.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (t.includes(q)) score = 3;
    return { e, score };
  })
    .filter((s) => s.score < 99)
    .sort((a, b) => a.score - b.score || a.e.ticker.localeCompare(b.e.ticker))
    .slice(0, limit);

  return scored.map((s) => catalogEntryToTicker(s.e));
}
