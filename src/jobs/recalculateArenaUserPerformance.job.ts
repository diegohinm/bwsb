import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { prisma } from "../lib/prisma.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { num } from "../lib/numeric.js";
import {
  ARENA_PERIODS,
  PUBLIC_DELAY_MS,
  periodBounds,
  publicPriceCutoff,
  type ArenaPeriod,
} from "../services/arena/arenaPeriods.js";

/**
 * WORKER JOB — the public Arena user leaderboard.
 *
 * Values every eligible user's virtual portfolio at DELAYED public prices,
 * computes the period return, ranks by that return, and stamps each row with
 * `public_after = calculatedAt + delay`.
 *
 * Three decisions worth stating:
 *
 *   RANK BY RETURN, not equity. Starting cash differs between users, so ranking
 *   by portfolio value would rank the best-funded rather than the best.
 *
 *   ELIGIBILITY IS ACTIVITY. A registered user who never traded is counted in
 *   the metadata but not ranked — giving them 0% would put them above everyone
 *   having a bad week, which is a claim the data does not support.
 *
 *   PRICES ARE THE PUBLIC ONES. Positions are marked at quotes at least the
 *   public delay old, so the leaderboard cannot be read backwards into a live
 *   price.
 */

/** Positions with no publicly quotable price fall back to their entry cost. */
type PriceMap = Map<string, number>;

async function publicPrices(symbols: string[], cutoff: Date): Promise<PriceMap> {
  if (symbols.length === 0) return new Map();
  const out: PriceMap = new Map();

  // One indexed query per symbol: newest observation at or before the cutoff.
  //
  // BOUNDED. This used to be `Promise.all(symbols.map(...))`, which started one
  // query per symbol simultaneously — a competition covering a hundred tickers
  // opened a hundred tasks against a three-connection pool, and the tail of
  // that queue timed out fetching a connection (P2024) rather than failing on
  // anything to do with the data.
  await mapWithConcurrency(symbols, async (symbol) => {
    const row = await prisma.marketQuoteSnapshots.findFirst({
      where: { symbol, observedAt: { lte: cutoff }, price: { not: null } },
      orderBy: { observedAt: "desc" },
      select: { price: true },
    });
    const price = num(row?.price ?? null);
    if (price !== null && price > 0) out.set(symbol, price);
  });

  return out;
}

interface Candidate {
  userId: string;
  startingCash: number;
  cashBalance: number;
  positions: { ticker: string | null; quantity: number; avgPrice: number }[];
  trades: { ticker: string | null; side: string | null; quantity: number; price: number; createdAt: Date }[];
}

/**
 * Equity at DELAYED prices: cash plus every position marked to the newest
 * publicly quotable price, or to its own cost when no such quote exists.
 */
function equityOf(candidate: Candidate, prices: PriceMap): number {
  const positions = candidate.positions.reduce((sum, p) => {
    const mark = (p.ticker ? prices.get(p.ticker.toUpperCase()) : undefined) ?? p.avgPrice;
    return sum + p.quantity * mark;
  }, 0);
  return candidate.cashBalance + positions;
}

/**
 * What the account was worth when the period opened.
 *
 * Derived by unwinding this period's trades from current cash: every buy inside
 * the window returns its cost, every sell gives its proceeds back. Positions
 * opened before the window are valued at cost, which is the best the current
 * schema supports — there is no per-day equity history to read instead.
 */
function startingEquityOf(candidate: Candidate, periodStart: Date): number {
  let cash = candidate.cashBalance;
  let positionsCost = candidate.positions.reduce((s, p) => s + p.quantity * p.avgPrice, 0);

  for (const trade of candidate.trades) {
    if (trade.createdAt < periodStart) continue;
    const value = trade.quantity * trade.price;
    if (trade.side === "sell") {
      cash -= value;
      positionsCost += value;
    } else {
      cash += value;
      positionsCost -= value;
    }
  }

  return cash + positionsCost;
}

/** Realized results per closed trade, for win rate and the best trade. */
function tradeStats(candidate: Candidate, periodStart: Date) {
  const inPeriod = candidate.trades.filter((t) => t.createdAt >= periodStart);
  // Average cost per symbol from buys, so a sell can be scored against it.
  const cost = new Map<string, { qty: number; total: number }>();
  for (const t of inPeriod) {
    if (!t.ticker || t.side === "sell") continue;
    const key = t.ticker.toUpperCase();
    const acc = cost.get(key) ?? { qty: 0, total: 0 };
    acc.qty += t.quantity;
    acc.total += t.quantity * t.price;
    cost.set(key, acc);
  }

  let wins = 0;
  let closed = 0;
  let bestTicker: string | null = null;
  let bestReturn: number | null = null;

  for (const t of inPeriod) {
    if (!t.ticker || t.side !== "sell") continue;
    const key = t.ticker.toUpperCase();
    const acc = cost.get(key);
    if (!acc || acc.qty <= 0) continue;
    const avg = acc.total / acc.qty;
    if (avg <= 0) continue;

    const returnPct = ((t.price - avg) / avg) * 100;
    closed += 1;
    if (returnPct > 0) wins += 1;
    if (bestReturn === null || returnPct > bestReturn) {
      bestReturn = returnPct;
      bestTicker = key;
    }
  }

  return {
    tradeCount: inPeriod.length,
    winRatePct: closed > 0 ? Math.round((wins / closed) * 1000) / 10 : null,
    bestTicker,
    bestTradeReturnPct: bestReturn === null ? null : Math.round(bestReturn * 100) / 100,
  };
}

export async function recalculateArenaUserPerformance(): Promise<JobMetadata> {
  const now = new Date();
  const cutoff = publicPriceCutoff(now);

  const [registeredUsers, accounts] = await Promise.all([
    prisma.appUsers.count(),
    prisma.virtualAccounts.findMany({
      select: {
        userId: true,
        startingCash: true,
        cashBalance: true,
        virtualPositions: { select: { ticker: true, quantity: true, avgCost: true } },
        virtualTrades: {
          select: { ticker: true, side: true, quantity: true, price: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
  ]);

  const candidates: Candidate[] = accounts.map((a) => ({
    userId: a.userId,
    startingCash: num(a.startingCash) ?? 0,
    cashBalance: num(a.cashBalance) ?? 0,
    positions: a.virtualPositions.map((p) => ({
      ticker: p.ticker,
      quantity: num(p.quantity) ?? 0,
      avgPrice: num(p.avgCost) ?? 0,
    })),
    trades: a.virtualTrades.map((t) => ({
      ticker: t.ticker,
      side: t.side,
      quantity: num(t.quantity) ?? 0,
      price: num(t.price) ?? 0,
      createdAt: t.createdAt,
    })),
  }));

  // Activity is the eligibility bar: an untouched account has no performance to
  // rank, and pretending otherwise would place it above every user down on the
  // period.
  const eligible = candidates.filter((c) => c.trades.length > 0 || c.positions.length > 0);

  const symbols = [
    ...new Set(
      eligible.flatMap((c) => c.positions.map((p) => p.ticker?.toUpperCase()).filter(Boolean)),
    ),
  ] as string[];
  const prices = await publicPrices(symbols, cutoff);

  const calculatedAt = now;
  const publicAfter = new Date(now.getTime() + PUBLIC_DELAY_MS);
  const perPeriod: Record<string, unknown> = {};

  for (const period of ARENA_PERIODS as readonly ArenaPeriod[]) {
    const { start, end } = periodBounds(period, now);

    const scored = eligible
      .map((candidate) => {
        const portfolioValue = equityOf(candidate, prices);
        const periodStartingEquity = startingEquityOf(candidate, start);
        const base = periodStartingEquity > 0 ? periodStartingEquity : candidate.startingCash;
        const periodPnl = portfolioValue - periodStartingEquity;
        const returnPct = base > 0 ? (periodPnl / base) * 100 : 0;
        return {
          candidate,
          portfolioValue,
          periodStartingEquity,
          periodPnl,
          returnPct: Math.round(returnPct * 100) / 100,
          ...tradeStats(candidate, start),
        };
      })
      .sort(
        (a, b) =>
          b.returnPct - a.returnPct ||
          (b.winRatePct ?? 0) - (a.winRatePct ?? 0) ||
          b.tradeCount - a.tradeCount,
      );

    if (scored.length > 0) {
      await prisma.arenaUserPerformanceSnapshots.createMany({
        data: scored.map((s, index) => ({
          userId: s.candidate.userId,
          period,
          periodStart: start,
          periodEnd: end,
          rank: index + 1,
          periodStartingEquity: s.periodStartingEquity,
          portfolioValue: s.portfolioValue,
          periodPnl: s.periodPnl,
          returnPct: s.returnPct,
          winRatePct: s.winRatePct,
          tradeCount: s.tradeCount,
          bestTicker: s.bestTicker,
          bestTradeReturnPct: s.bestTradeReturnPct,
          maximumDrawdownPct: null,
          calculatedAt,
          publicAfter,
          isMock: false,
        })),
      });
    }

    perPeriod[period] = { ranked: scored.length };
  }

  return {
    calculatedAt: calculatedAt.toISOString(),
    publicAfter: publicAfter.toISOString(),
    registeredUsers,
    accounts: accounts.length,
    eligibleUsers: eligible.length,
    perPeriod,
  };
}

// Manual run: npm run arena:users:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("recalculateArenaUserPerformance", recalculateArenaUserPerformance);
}
