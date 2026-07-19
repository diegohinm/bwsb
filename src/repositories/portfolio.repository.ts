import { query } from "../lib/db.js";

/** Data access for demo watchlists, portfolio positions and daily summaries. */
export const portfolioRepository = {
  positions(userId: string) {
    return query(
      `SELECT * FROM public.user_portfolio_positions WHERE user_id = $1 ORDER BY ticker ASC`,
      [userId],
    );
  },

  watchlistItems(userId: string) {
    return query(
      `SELECT wi.ticker, w.name
       FROM public.user_watchlists w
       JOIN public.user_watchlist_items wi ON wi.watchlist_id = w.id
       WHERE w.user_id = $1
       ORDER BY wi.ticker ASC`,
      [userId],
    );
  },

  dailySummary(userId: string) {
    return query(
      `SELECT * FROM public.daily_summaries WHERE user_id = $1 ORDER BY day DESC LIMIT 1`,
      [userId],
    );
  },

  webhooks(userId: string) {
    return query(
      `SELECT id, user_id, target_url, event_types, is_active, created_at
       FROM public.webhook_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
  },

  insertWebhook(userId: string, targetUrl: string, eventTypes: unknown) {
    return query(
      `INSERT INTO public.webhook_subscriptions (user_id, target_url, event_types)
       VALUES ($1,$2,$3::jsonb) RETURNING id, user_id, target_url, event_types, is_active, created_at`,
      [userId, targetUrl, JSON.stringify(eventTypes)],
    );
  },

  deleteWebhook(userId: string, id: string) {
    return query(
      `DELETE FROM public.webhook_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
  },
};
