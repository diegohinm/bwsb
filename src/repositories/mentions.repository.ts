import { query } from "../lib/db.js";
import type { TickerMention } from "../types/domain.js";

/** Data access for ticker mentions and stance events. */
export const mentionsRepository = {
  forTicker(ticker: string, limit = 100): Promise<TickerMention[]> {
    return query<TickerMention>(
      `SELECT m.id, m.ticker, m.reddit_post_id, m.pump_language_score, m.narrative_type, m.created_at
       FROM public.ticker_mentions m
       WHERE m.ticker = $1
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [ticker, limit],
    );
  },

  withPostForTicker(ticker: string, limit = 100) {
    return query(
      `SELECT m.id, m.ticker, m.reddit_post_id, m.pump_language_score, m.narrative_type, m.created_at,
              p.title, p.subreddit, p.score, p.num_comments, p.permalink, p.reddit_created_at
       FROM public.ticker_mentions m
       JOIN public.reddit_posts p ON p.reddit_post_id = m.reddit_post_id
       WHERE m.ticker = $1
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [ticker, limit],
    );
  },

  stanceForTicker(ticker: string) {
    return query(
      `SELECT ticker, subreddit, stance, confidence, matched_terms, created_at
       FROM public.ticker_stance_events WHERE ticker = $1 ORDER BY created_at DESC`,
      [ticker],
    );
  },

  stanceSplit(ticker: string) {
    return query(
      `SELECT stance, count(*)::int AS n
       FROM public.ticker_stance_events WHERE ticker = $1 GROUP BY stance`,
      [ticker],
    );
  },

  /** Divergence of stance across subreddits for a ticker. */
  stanceBySubreddit(ticker: string) {
    return query(
      `SELECT subreddit,
              count(*) FILTER (WHERE stance='bullish')::int AS bullish,
              count(*) FILTER (WHERE stance='bearish')::int AS bearish,
              count(*) FILTER (WHERE stance='neutral')::int AS neutral
       FROM public.ticker_stance_events WHERE ticker = $1 GROUP BY subreddit`,
      [ticker],
    );
  },
};
