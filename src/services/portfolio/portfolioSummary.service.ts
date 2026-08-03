import { prisma } from "../../lib/prisma.js";
import { num } from "../../lib/numeric.js";
import { ensureAccount } from "./virtualAccount.service.js";
import { PUBLIC_DELAY_MINUTES, publicPriceCutoff } from "../arena/arenaPeriods.js";

/**
 * THE canonical portfolio value. One calculation, one shape, one endpoint.
 *
 * Before this existed, three surfaces showed three different numbers — the
 * sidebar a fixture, the header a "points" fixture, the account page the stored
 * `equity_value` column. They disagreed because each computed (or invented) its
 * own. Everything now reads this.
 *
 *   equity = cash balance + market value of every open position
 *
 * Positions are marked to STORED, DELAYED quotes (`market_quote_snapshots`, the
 * same table the Arena and the Calendar use), never to a provider call. A
 * position with no eligible quote is valued at its average cost and COUNTED, so
 * the caller can say how much of the number is marked to market rather than
 * quietly presenting cost basis as a market value.
 *
 * Day and month P/L need a prior equity reading, which comes from the snapshot
 * history. Until that history exists they are NULL — an unknown change is not
 * zero, and printing 0.00% would be a claim we cannot support.
 */

export type PortfolioSummary = {
  startingCash: number;
  cashBalance: number;
  positionsMarketValue: number;
  equityValue: number;
  /** Equity minus the cash the account was opened with. Always computable. */
  totalPnL: number;
  totalPnLPercent: number | null;
  /** Null until there is a prior snapshot to compare against. Never faked. */
  dayPnL: number | null;
  dayPnLPercent: number | null;
  monthlyPnL: number | null;
  monthlyPnLPercent: number | null;
  /** Null when the user is not ranked in the Arena. */
  arenaRank: number | null;
  positionCount: number;
  /** How many positions had a usable delayed quote. */
  pricedPositionCount: number;
  currency: string;
  calculatedAt: string;
  /** Newest quote instant used. Null when nothing was marked to market. */
  priceObservedAt: string | null;
  displayMode: "delayed";
  delayMinutes: number;
  /** True when a position could not be marked to market. */
  isStale: boolean;
};

const round = (n: number): number => Math.round(n * 100) / 100;

/** Option contracts cover 100 shares; stock is 1:1. */
function multiplierFor(instrument: string | null): number {
  return instrument === "option" ? 100 : 1;
}

/**
 * Newest publicly quotable price per symbol, batched.
 *
 * Filtered to the same delay the public surfaces use. A portfolio is private,
 * but marking it with fresher prices than anything else in the product would
 * make it an indirect real-time feed — one query away from being exactly that.
 */
async function delayedPrices(
  symbols: string[],
  now: Date,
): Promise<{ prices: Map<string, number>; newestObservedAt: Date | null }> {
  const prices = new Map<string, number>();
  if (symbols.length === 0) return { prices, newestObservedAt: null };

  const where = {
    symbol: { in: symbols },
    observedAt: { lte: publicPriceCutoff(now) },
    price: { not: null },
  };

  const bounds = await prisma.marketQuoteSnapshots.groupBy({
    by: ["symbol"],
    where,
    _max: { observedAt: true },
  });
  if (bounds.length === 0) return { prices, newestObservedAt: null };

  const instants = bounds
    .map((b) => b._max.observedAt)
    .filter((d): d is Date => Boolean(d));

  const rows = await prisma.marketQuoteSnapshots.findMany({
    where: { symbol: { in: symbols }, observedAt: { in: instants } },
    select: { symbol: true, price: true, observedAt: true },
  });

  const newest = new Map<string, { at: number; price: number | null }>();
  for (const r of rows) {
    const at = r.observedAt?.getTime() ?? 0;
    const current = newest.get(r.symbol);
    if (!current || at > current.at) newest.set(r.symbol, { at, price: num(r.price) });
  }

  let newestObservedAt: Date | null = null;
  for (const [symbol, v] of newest) {
    if (v.price === null) continue;
    prices.set(symbol, v.price);
    if (!newestObservedAt || v.at > newestObservedAt.getTime()) {
      newestObservedAt = new Date(v.at);
    }
  }
  return { prices, newestObservedAt };
}

/** The Arena rank for this user, or null when they are not ranked. */
async function arenaRankOf(userId: string): Promise<number | null> {
  const row = await prisma.arenaUserPerformanceSnapshots.findFirst({
    where: { userId, period: "daily" },
    orderBy: { calculatedAt: "desc" },
    select: { rank: true },
  });
  return row?.rank ?? null;
}

/** Equity as of the newest snapshot at or before `at`, or null when none. */
async function equityAsOf(accountId: string, at: Date): Promise<number | null> {
  const row = await prisma.virtualEquitySnapshots.findFirst({
    where: { virtualAccountId: accountId, calculatedAt: { lte: at } },
    orderBy: { calculatedAt: "desc" },
    select: { equityValue: true },
  });
  return row ? num(row.equityValue) : null;
}

const pctChange = (from: number, delta: number): number | null =>
  from > 0 ? Math.round((delta / from) * 10000) / 100 : null;

/**
 * Build the summary for one user. Reads only; never calls a provider.
 *
 * It also refreshes the stored `equity_value` column so the account row and
 * this calculation cannot drift — that column is a cache of this result, not a
 * second opinion about it.
 */
export async function getPortfolioSummary(
  userId: string,
  now: Date = new Date(),
): Promise<PortfolioSummary> {
  const account = await ensureAccount(userId);

  const positions = await prisma.virtualPositions.findMany({
    where: { virtualAccountId: account.id },
    select: {
      ticker: true,
      instrument: true,
      quantity: true,
      avgCost: true,
    },
  });

  const symbols = [
    ...new Set(
      positions
        .map((p) => p.ticker?.toUpperCase())
        .filter((t): t is string => Boolean(t)),
    ),
  ];
  const { prices, newestObservedAt } = await delayedPrices(symbols, now);

  let positionsMarketValue = 0;
  let pricedPositionCount = 0;

  for (const position of positions) {
    const quantity = num(position.quantity) ?? 0;
    const avgCost = num(position.avgCost) ?? 0;
    const symbol = position.ticker?.toUpperCase();
    const quote = symbol ? prices.get(symbol) : undefined;

    // No eligible quote → valued at cost. Counted separately so the caller can
    // tell the user which part of the number is actually marked to market.
    const price = quote ?? avgCost;
    if (quote !== undefined) pricedPositionCount += 1;

    positionsMarketValue += price * quantity * multiplierFor(position.instrument);
  }

  positionsMarketValue = round(positionsMarketValue);
  const startingCash = num(account.starting_cash) ?? 0;
  const cashBalance = round(num(account.cash_balance) ?? 0);
  const equityValue = round(cashBalance + positionsMarketValue);

  // Keep the stored column in step with the canonical calculation.
  await prisma.virtualAccounts
    .update({
      where: { id: account.id },
      data: { equityValue, updatedAt: now },
    })
    .catch(() => undefined);

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [dayBaseline, monthBaseline, arenaRank] = await Promise.all([
    equityAsOf(account.id, dayStart),
    equityAsOf(account.id, monthStart),
    arenaRankOf(userId),
  ]);

  const dayPnL = dayBaseline === null ? null : round(equityValue - dayBaseline);
  const monthlyPnL = monthBaseline === null ? null : round(equityValue - monthBaseline);
  const totalPnL = round(equityValue - startingCash);

  return {
    startingCash,
    cashBalance,
    positionsMarketValue,
    equityValue,
    totalPnL,
    totalPnLPercent: pctChange(startingCash, totalPnL),
    dayPnL,
    dayPnLPercent: dayBaseline === null || dayPnL === null ? null : pctChange(dayBaseline, dayPnL),
    monthlyPnL,
    monthlyPnLPercent:
      monthBaseline === null || monthlyPnL === null ? null : pctChange(monthBaseline, monthlyPnL),
    arenaRank,
    positionCount: positions.length,
    pricedPositionCount,
    currency: account.currency ?? "USD",
    calculatedAt: now.toISOString(),
    priceObservedAt: newestObservedAt ? newestObservedAt.toISOString() : null,
    displayMode: "delayed",
    delayMinutes: PUBLIC_DELAY_MINUTES,
    // Stale means "part of this number is cost basis, not a market price".
    isStale: positions.length > 0 && pricedPositionCount < positions.length,
  };
}

/**
 * Append today's equity reading to the history the day/month comparisons read.
 *
 * Called by the worker job, not on read: a GET that writes a snapshot would
 * make the baseline move every time somebody opened the page, and "today's P/L"
 * would always be zero.
 */
export async function recordEquitySnapshot(
  userId: string,
  now: Date = new Date(),
): Promise<PortfolioSummary> {
  const summary = await getPortfolioSummary(userId, now);
  const account = await ensureAccount(userId);

  await prisma.virtualEquitySnapshots.create({
    data: {
      virtualAccountId: account.id,
      userId,
      cashBalance: summary.cashBalance,
      positionsMarketValue: summary.positionsMarketValue,
      equityValue: summary.equityValue,
      calculatedAt: new Date(summary.calculatedAt),
      priceObservedAt: summary.priceObservedAt ? new Date(summary.priceObservedAt) : null,
      isStale: summary.isStale,
    },
  });

  return summary;
}
