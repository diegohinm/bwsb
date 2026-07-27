import { Prisma } from "@prisma/client";
import type {
  DailySummaries,
  UserPortfolioPositions,
  WebhookSubscriptions,
} from "@prisma/client";

import { prisma } from "../lib/prisma.js";

/**
 * Data access for demo watchlists, portfolio positions and daily summaries.
 *
 * Prisma models are camelCase, but these rows are serialized straight onto the
 * wire by the product routes, so each one is mapped back to the snake_case keys
 * the API has always returned. `numeric` columns stay strings, as the pg driver
 * returned them.
 */

function dec(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

export interface PortfolioPositionRow {
  id: string;
  user_id: string;
  ticker: string;
  quantity: string | null;
  avg_cost: string | null;
  instrument: string;
  opened_at: Date | null;
  metadata: Prisma.JsonValue;
  created_at: Date;
}

function toPosition(r: UserPortfolioPositions): PortfolioPositionRow {
  return {
    id: r.id,
    user_id: r.userId,
    ticker: r.ticker,
    quantity: dec(r.quantity),
    avg_cost: dec(r.avgCost),
    instrument: r.instrument,
    opened_at: r.openedAt,
    metadata: r.metadata,
    created_at: r.createdAt,
  };
}

export interface DailySummaryRow {
  id: string;
  user_id: string | null;
  day: Date;
  summary: string | null;
  highlights: Prisma.JsonValue;
  created_at: Date;
}

function toDailySummary(r: DailySummaries): DailySummaryRow {
  return {
    id: r.id,
    user_id: r.userId,
    day: r.day,
    summary: r.summary,
    highlights: r.highlights,
    created_at: r.createdAt,
  };
}

/** The webhook columns safe to return — `secret` is deliberately excluded. */
const WEBHOOK_COLUMNS = {
  id: true,
  userId: true,
  targetUrl: true,
  eventTypes: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.WebhookSubscriptionsSelect;

type SelectedWebhook = Pick<
  WebhookSubscriptions,
  "id" | "userId" | "targetUrl" | "eventTypes" | "isActive" | "createdAt"
>;

export interface WebhookRow {
  id: string;
  user_id: string;
  target_url: string;
  event_types: Prisma.JsonValue;
  is_active: boolean;
  created_at: Date;
}

function toWebhook(r: SelectedWebhook): WebhookRow {
  return {
    id: r.id,
    user_id: r.userId,
    target_url: r.targetUrl,
    event_types: r.eventTypes,
    is_active: r.isActive,
    created_at: r.createdAt,
  };
}

export const portfolioRepository = {
  async positions(userId: string): Promise<PortfolioPositionRow[]> {
    const rows = await prisma.userPortfolioPositions.findMany({
      where: { userId },
      orderBy: { ticker: "asc" },
    });
    return rows.map(toPosition);
  },

  /** Watchlist tickers across all of the user's watchlists, with the list name. */
  async watchlistItems(userId: string): Promise<{ ticker: string; name: string }[]> {
    const watchlists = await prisma.userWatchlists.findMany({
      where: { userId },
      select: {
        name: true,
        userWatchlistItems: { select: { ticker: true } },
      },
    });

    return watchlists
      .flatMap((w) => w.userWatchlistItems.map((i) => ({ ticker: i.ticker, name: w.name })))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  },

  /** Newest daily summary as a 0- or 1-element list — the shape callers expect. */
  async dailySummary(userId: string): Promise<DailySummaryRow[]> {
    const rows = await prisma.dailySummaries.findMany({
      where: { userId },
      orderBy: { day: "desc" },
      take: 1,
    });
    return rows.map(toDailySummary);
  },

  async webhooks(userId: string): Promise<WebhookRow[]> {
    const rows = await prisma.webhookSubscriptions.findMany({
      where: { userId },
      select: WEBHOOK_COLUMNS,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toWebhook);
  },

  /** Returns a 1-element list, mirroring the old INSERT … RETURNING. */
  async insertWebhook(
    userId: string,
    targetUrl: string,
    eventTypes: unknown,
  ): Promise<WebhookRow[]> {
    const row = await prisma.webhookSubscriptions.create({
      data: {
        userId,
        targetUrl,
        eventTypes: (eventTypes ?? []) as Prisma.InputJsonValue,
      },
      select: WEBHOOK_COLUMNS,
    });
    return [toWebhook(row)];
  },

  /** Returns the deleted ids — empty when the webhook was not this user's. */
  async deleteWebhook(userId: string, id: string): Promise<{ id: string }[]> {
    // Scoped delete: deleteMany applies the user_id guard in the same statement,
    // so one user can never remove another's webhook.
    const existing = await prisma.webhookSubscriptions.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!existing) return [];

    const { count } = await prisma.webhookSubscriptions.deleteMany({
      where: { id, userId },
    });
    return count > 0 ? [existing] : [];
  },
};
