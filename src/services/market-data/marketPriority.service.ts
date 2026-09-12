import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { BUCKET_MINUTES } from "../social/tickerActivity.service.js";
import { MARKET_PRIORITY, type MarketPriority } from "./marketDataQueue.service.js";

/**
 * WHICH SYMBOLS DESERVE MARKET DATA, AND HOW URGENTLY.
 *
 * This is the join between the two pipelines, and it runs in ONE DIRECTION
 * ONLY: Reddit activity (already in Postgres) decides what the market worker
 * should go and fetch. Nothing here is called while ingesting a Reddit item,
 * and nothing here can make a Reddit write wait — it is a scheduled read of
 * tables that are already written.
 *
 * That direction is the whole architecture in miniature. The forbidden shape is
 *
 *     reddit item → ticker detected → Databento → save
 *
 * and the shape implemented is
 *
 *     reddit item → save … (later, separately) … DB → queue → Databento → DB
 *
 * WHY PRIORITY EXISTS AT ALL. The previous design refreshed sixteen hardcoded
 * symbols at one rate. Everything else got nothing, and the sixteen got the same
 * attention whether or not anyone was looking. Ranking demand lets a small,
 * fixed provider budget go to the symbols someone is about to look at.
 */

/** Symbols ranked this far up Top Tickers are treated as about-to-be-viewed. */
const TRENDING_LIMIT = 30;

/** How far back "Reddit is currently talking about this" reaches. */
const ACTIVE_WINDOW_HOURS = 24;

/** Bound on one sweep, so a busy day cannot enqueue thousands of jobs. */
export const MAX_ACTIVE_SYMBOLS = 300;

export type PrioritizedTicker = { ticker: string; priority: MarketPriority; reason: string };

/**
 * Symbols someone has an explicit, standing interest in.
 *
 * A watchlist entry or an open position is a statement that this person wants to
 * know what the symbol is doing — the strongest demand signal available, and one
 * that does not depend on anybody having a page open this second.
 */
async function heldSymbols(): Promise<Set<string>> {
  const [watchlist, portfolio, virtual] = await Promise.all([
    prisma.userWatchlistItems.findMany({ select: { ticker: true }, distinct: ["ticker"] }),
    prisma.userPortfolioPositions.findMany({ select: { ticker: true }, distinct: ["ticker"] }),
    prisma.virtualPositions.findMany({
      // A closed position is history; its symbol needs no live quote.
      where: { ticker: { not: null }, quantity: { not: 0 } },
      select: { ticker: true },
      distinct: ["ticker"],
    }),
  ]);

  const out = new Set<string>();
  for (const row of [...watchlist, ...portfolio, ...virtual]) {
    if (row.ticker) out.add(row.ticker.toUpperCase());
  }
  return out;
}

/**
 * Symbols Reddit is talking about, most-discussed first.
 *
 * Read from `ticker_activity`, which is exactly what Top Tickers reads — so the
 * market worker refreshes the symbols the summary is about to display, rather
 * than a list maintained separately and drifting from it.
 */
async function discussedSymbols(now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - ACTIVE_WINDOW_HOURS * 3_600_000);

  const rows = await prisma.$queryRaw<{ ticker: string }[]>(Prisma.sql`
    SELECT ticker
      FROM ticker_activity
     WHERE bucket_minutes = ${BUCKET_MINUTES}
       AND bucket_start >= ${since}
     GROUP BY ticker
     ORDER BY sum(mentions) DESC
     LIMIT ${MAX_ACTIVE_SYMBOLS}`);

  return rows.map((r) => r.ticker);
}

/**
 * The full demand picture, deduplicated, best priority per symbol.
 *
 * A symbol can qualify twice — NVDA is both trending and in half the watchlists.
 * The strongest claim wins, so a held symbol is never demoted by also being
 * merely popular.
 */
export async function resolveMarketPriorities(now = new Date()): Promise<PrioritizedTicker[]> {
  const [held, discussed] = await Promise.all([heldSymbols(), discussedSymbols(now)]);

  const best = new Map<string, PrioritizedTicker>();
  const claim = (ticker: string, priority: MarketPriority, reason: string) => {
    const existing = best.get(ticker);
    if (existing && existing.priority <= priority) return;
    best.set(ticker, { ticker, priority, reason });
  };

  for (const ticker of held) claim(ticker, MARKET_PRIORITY.REALTIME, "watchlist-or-position");
  discussed.forEach((ticker, index) => {
    claim(
      ticker,
      index < TRENDING_LIMIT ? MARKET_PRIORITY.TRENDING : MARKET_PRIORITY.ACTIVE,
      index < TRENDING_LIMIT ? "top-mentioned" : "reddit-active",
    );
  });

  return [...best.values()].sort((a, b) => a.priority - b.priority || a.ticker.localeCompare(b.ticker));
}
