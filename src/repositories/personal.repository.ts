import { query, queryOne } from "../lib/db.js";

/**
 * Data access for a signed-in user's personal records: watchlist, personal
 * alert rules and notifications. Keyed by users(id).
 */
export const personalRepository = {
  // ── Watchlist ─────────────────────────────────────────────────────────────
  /** Return the user's default watchlist id, creating it if needed. */
  async ensureDefaultWatchlist(userId: string): Promise<string> {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM public.user_watchlists WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [userId],
    );
    if (existing) return existing.id;
    const created = await queryOne<{ id: string }>(
      `INSERT INTO public.user_watchlists (user_id, name) VALUES ($1, 'Default') RETURNING id`,
      [userId],
    );
    return created!.id;
  },

  watchlistItems(userId: string) {
    return query(
      `SELECT wi.id, wi.ticker, wi.created_at, t.company_name, t.exchange
       FROM public.user_watchlists w
       JOIN public.user_watchlist_items wi ON wi.watchlist_id = w.id
       LEFT JOIN public.tickers t ON t.ticker = wi.ticker
       WHERE w.user_id = $1
       ORDER BY wi.created_at DESC`,
      [userId],
    );
  },

  async addWatchlistItem(userId: string, ticker: string) {
    const watchlistId = await this.ensureDefaultWatchlist(userId);
    return queryOne(
      `INSERT INTO public.user_watchlist_items (watchlist_id, ticker)
       VALUES ($1, $2)
       ON CONFLICT (watchlist_id, ticker) DO NOTHING
       RETURNING *`,
      [watchlistId, ticker.toUpperCase()],
    );
  },

  removeWatchlistItem(userId: string, ticker: string) {
    return query(
      `DELETE FROM public.user_watchlist_items wi
       USING public.user_watchlists w
       WHERE wi.watchlist_id = w.id AND w.user_id = $1 AND wi.ticker = $2
       RETURNING wi.id`,
      [userId, ticker.toUpperCase()],
    );
  },

  // ── Personal alert rules ──────────────────────────────────────────────────
  myAlerts(userId: string) {
    return query(
      `SELECT id, user_id, ticker, alert_type, condition, delivery_channels, is_active, created_at
       FROM public.user_alert_rules WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
  },

  createAlert(rule: {
    user_id: string;
    ticker: string | null;
    alert_type: string;
    condition: unknown;
    delivery_channels: unknown;
  }) {
    return queryOne(
      `INSERT INTO public.user_alert_rules
         (user_id, ticker, alert_type, rule_type, condition, delivery_channels, is_active)
       VALUES ($1,$2,$3,$3,$4::jsonb,$5::jsonb,true)
       RETURNING id, user_id, ticker, alert_type, condition, delivery_channels, is_active, created_at`,
      [
        rule.user_id, rule.ticker, rule.alert_type,
        JSON.stringify(rule.condition ?? {}), JSON.stringify(rule.delivery_channels ?? []),
      ],
    );
  },

  deleteAlert(userId: string, id: string) {
    return query(
      `DELETE FROM public.user_alert_rules WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  notifications(userId: string, limit = 50) {
    return query(
      `SELECT * FROM public.user_notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
  },

  markNotificationRead(userId: string, id: string) {
    return query(
      `UPDATE public.user_notifications SET read_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING id, read_at`,
      [id, userId],
    );
  },
};
