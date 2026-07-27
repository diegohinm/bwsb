import { Prisma } from "@prisma/client";
import type { UserAlertRules, UserNotifications } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

/**
 * Data access for a signed-in user's personal records: watchlist, personal
 * alert rules and notifications. Keyed by app_users(id).
 *
 * Rows are mapped back to snake_case: the personal routes serialize them
 * straight onto the wire, so these key names are the API contract.
 */

export interface WatchlistItemRow {
  id: string;
  ticker: string;
  created_at: Date;
  company_name: string | null;
  exchange: string | null;
}

export interface AlertRuleRow {
  id: string;
  user_id: string;
  ticker: string | null;
  alert_type: string | null;
  condition: Prisma.JsonValue;
  delivery_channels: Prisma.JsonValue;
  is_active: boolean;
  created_at: Date;
}

function toAlertRule(r: UserAlertRules): AlertRuleRow {
  return {
    id: r.id,
    user_id: r.userId,
    ticker: r.ticker,
    alert_type: r.alertType,
    condition: r.condition,
    delivery_channels: r.deliveryChannels,
    is_active: r.isActive,
    created_at: r.createdAt,
  };
}

export interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  metadata: Prisma.JsonValue;
  read_at: Date | null;
  created_at: Date;
}

function toNotification(r: UserNotifications): NotificationRow {
  return {
    id: r.id,
    user_id: r.userId,
    title: r.title,
    body: r.body,
    metadata: r.metadata,
    read_at: r.readAt,
    created_at: r.createdAt,
  };
}

export const personalRepository = {
  // ── Watchlist ─────────────────────────────────────────────────────────────
  /** Return the user's default watchlist id, creating it if needed. */
  async ensureDefaultWatchlist(userId: string): Promise<string> {
    const existing = await prisma.userWatchlists.findFirst({
      where: { userId },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (existing) return existing.id;

    const created = await prisma.userWatchlists.create({
      data: { userId, name: "Default" },
      select: { id: true },
    });
    return created.id;
  },

  /** Every item across the user's watchlists, enriched with ticker reference data. */
  async watchlistItems(userId: string): Promise<WatchlistItemRow[]> {
    const rows = await prisma.userWatchlistItems.findMany({
      where: { userWatchlists: { userId } },
      select: { id: true, ticker: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    if (rows.length === 0) return [];

    // The LEFT JOIN on public.tickers, as a second lookup: user_watchlist_items
    // has no foreign key to tickers, so a watchlist can hold a symbol we have no
    // reference row for and those items must still be returned.
    const reference = await prisma.tickers.findMany({
      where: { ticker: { in: rows.map((r) => r.ticker) } },
      select: { ticker: true, companyName: true, exchange: true },
    });
    const byTicker = new Map(reference.map((t) => [t.ticker, t]));

    return rows.map((r) => ({
      id: r.id,
      ticker: r.ticker,
      created_at: r.createdAt,
      company_name: byTicker.get(r.ticker)?.companyName ?? null,
      exchange: byTicker.get(r.ticker)?.exchange ?? null,
    }));
  },

  /** Add a ticker; returns null when it is already on the watchlist. */
  async addWatchlistItem(userId: string, ticker: string) {
    const watchlistId = await this.ensureDefaultWatchlist(userId);
    const symbol = ticker.toUpperCase();

    const existing = await prisma.userWatchlistItems.findUnique({
      where: { watchlistId_ticker: { watchlistId, ticker: symbol } },
      select: { id: true },
    });
    // ON CONFLICT DO NOTHING RETURNING * returned no row for a duplicate.
    if (existing) return null;

    try {
      const created = await prisma.userWatchlistItems.create({
        data: { watchlistId, ticker: symbol },
      });
      return {
        id: created.id,
        watchlist_id: created.watchlistId,
        ticker: created.ticker,
        created_at: created.createdAt,
      };
    } catch (err) {
      // Lost a race against a concurrent add — still "already present".
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return null;
      }
      throw err;
    }
  },

  /** Returns the removed ids — empty when the ticker was not on a list. */
  async removeWatchlistItem(userId: string, ticker: string): Promise<{ id: string }[]> {
    const symbol = ticker.toUpperCase();
    const doomed = await prisma.userWatchlistItems.findMany({
      where: { ticker: symbol, userWatchlists: { userId } },
      select: { id: true },
    });
    if (doomed.length === 0) return [];

    await prisma.userWatchlistItems.deleteMany({
      where: { id: { in: doomed.map((d) => d.id) } },
    });
    return doomed;
  },

  // ── Personal alert rules ──────────────────────────────────────────────────
  async myAlerts(userId: string): Promise<AlertRuleRow[]> {
    const rows = await prisma.userAlertRules.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toAlertRule);
  },

  async createAlert(rule: {
    user_id: string;
    ticker: string | null;
    alert_type: string;
    condition: unknown;
    delivery_channels: unknown;
  }): Promise<AlertRuleRow> {
    const row = await prisma.userAlertRules.create({
      data: {
        userId: rule.user_id,
        ticker: rule.ticker,
        alertType: rule.alert_type,
        // rule_type is NOT NULL and predates alert_type; both carry the same value.
        ruleType: rule.alert_type,
        condition: (rule.condition ?? {}) as Prisma.InputJsonValue,
        deliveryChannels: (rule.delivery_channels ?? []) as Prisma.InputJsonValue,
        isActive: true,
      },
    });
    return toAlertRule(row);
  },

  /** Returns the deleted ids — empty when the rule was not this user's. */
  async deleteAlert(userId: string, id: string): Promise<{ id: string }[]> {
    const existing = await prisma.userAlertRules.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!existing) return [];

    const { count } = await prisma.userAlertRules.deleteMany({
      where: { id, userId },
    });
    return count > 0 ? [existing] : [];
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  async notifications(userId: string, limit = 50): Promise<NotificationRow[]> {
    const rows = await prisma.userNotifications.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toNotification);
  },

  /** Returns [{ id, read_at }] — empty when the notification was not this user's. */
  async markNotificationRead(
    userId: string,
    id: string,
  ): Promise<{ id: string; read_at: Date | null }[]> {
    const readAt = new Date();
    const { count } = await prisma.userNotifications.updateMany({
      where: { id, userId },
      data: { readAt },
    });
    return count > 0 ? [{ id, read_at: readAt }] : [];
  },
};
