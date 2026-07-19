import { query, queryOne } from "../lib/db.js";
import type { MarketSnapshot } from "../types/domain.js";

/** Data access for market data (snapshots, options, short interest, news…). */
export const marketRepository = {
  latestSnapshot(ticker: string): Promise<MarketSnapshot | null> {
    return queryOne<MarketSnapshot>(
      `SELECT * FROM public.market_snapshots WHERE ticker = $1
       ORDER BY snapshot_at DESC LIMIT 1`,
      [ticker],
    );
  },

  latestSnapshots(): Promise<MarketSnapshot[]> {
    return query<MarketSnapshot>(
      `SELECT DISTINCT ON (ticker) * FROM public.market_snapshots
       ORDER BY ticker, snapshot_at DESC`,
    );
  },

  optionContracts(ticker: string) {
    return query(
      `SELECT * FROM public.option_contract_snapshots WHERE ticker = $1
       ORDER BY expiration_date ASC, strike ASC`,
      [ticker],
    );
  },

  shortInterest(ticker: string) {
    return queryOne(
      `SELECT * FROM public.short_interest_snapshots WHERE ticker = $1
       ORDER BY snapshot_at DESC LIMIT 1`,
      [ticker],
    );
  },

  shortInterestLatest() {
    return query(
      `SELECT DISTINCT ON (ticker) * FROM public.short_interest_snapshots
       ORDER BY ticker, snapshot_at DESC`,
    );
  },

  newsForTicker(ticker: string, limit = 20) {
    return query(
      `SELECT * FROM public.news_events WHERE ticker = $1 ORDER BY published_at DESC LIMIT $2`,
      [ticker, limit],
    );
  },

  insiderForTicker(ticker: string, limit = 20) {
    return query(
      `SELECT * FROM public.insider_activity_events WHERE ticker = $1 ORDER BY filed_at DESC LIMIT $2`,
      [ticker, limit],
    );
  },

  externalSocial(ticker: string) {
    return queryOne(
      `SELECT * FROM public.external_social_snapshots WHERE ticker = $1
       ORDER BY snapshot_at DESC LIMIT 1`,
      [ticker],
    );
  },

  catalystsForTicker(ticker: string) {
    return query(
      `SELECT * FROM public.catalyst_events WHERE ticker = $1 ORDER BY event_date ASC`,
      [ticker],
    );
  },
};
