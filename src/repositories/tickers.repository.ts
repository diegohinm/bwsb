import { query, queryOne } from "../lib/db.js";
import type { Ticker } from "../types/domain.js";

/** Data access for tickers and their derived daily/narrative context. */
export const tickersRepository = {
  listAll(): Promise<Ticker[]> {
    return query<Ticker>(
      `SELECT ticker, company_name, exchange, is_active, is_common_word, created_at
       FROM public.tickers ORDER BY ticker ASC`,
    );
  },

  findByTicker(ticker: string): Promise<Ticker | null> {
    return queryOne<Ticker>(
      `SELECT ticker, company_name, exchange, is_active, is_common_word, created_at
       FROM public.tickers WHERE ticker = $1`,
      [ticker],
    );
  },

  search(term: string, limit = 20): Promise<Ticker[]> {
    return query<Ticker>(
      `SELECT ticker, company_name, exchange, is_active, is_common_word, created_at
       FROM public.tickers
       WHERE ticker ILIKE $1 OR company_name ILIKE $1
       ORDER BY (ticker ILIKE $2) DESC, ticker ASC
       LIMIT $3`,
      [`%${term}%`, `${term}%`, limit],
    );
  },

  /**
   * Global ticker/company search for the header search bar.
   * Ranking: exact ticker → ticker starts-with → company contains → ticker asc.
   */
  searchTickers(term: string, limit = 8): Promise<Ticker[]> {
    return query<Ticker>(
      `SELECT ticker, company_name, exchange, is_active, is_common_word
       FROM public.tickers
       WHERE ticker ILIKE $1 OR company_name ILIKE $2
       ORDER BY
         CASE
           WHEN upper(ticker) = upper($3) THEN 0
           WHEN ticker ILIKE $1 THEN 1
           WHEN company_name ILIKE $2 THEN 2
           ELSE 3
         END,
         ticker ASC
       LIMIT $4`,
      [`${term}%`, `%${term}%`, term, limit],
    );
  },

  dailyMetrics(ticker: string, days = 14) {
    return query(
      `SELECT ticker, day, mentions, unique_authors, bullish, bearish, neutral,
              sentiment_score, mention_share
       FROM public.ticker_daily_metrics
       WHERE ticker = $1 AND day >= current_date - $2::int
       ORDER BY day ASC`,
      [ticker, days],
    );
  },

  narratives(ticker: string) {
    return query(
      `SELECT id, ticker, narrative, narrative_type, strength, first_seen_at, last_seen_at, metadata
       FROM public.narrative_events WHERE ticker = $1 ORDER BY strength DESC`,
      [ticker],
    );
  },

  ddQuality(ticker: string) {
    return query(
      `SELECT id, reddit_post_id, ticker, score, category, explanation,
              evidence_score, source_score, calculation_score, catalyst_score,
              risk_disclosure_score, originality_score, created_at
       FROM public.dd_quality_scores WHERE ticker = $1 ORDER BY score DESC`,
      [ticker],
    );
  },
};
