import { prisma } from "../../lib/prisma.js";
import { num } from "../../lib/numeric.js";
import {
  PUBLIC_DELAY_MINUTES,
  type ArenaPeriod,
  type ArenaScope,
} from "./arenaPeriods.js";

/**
 * Arena reads — DATABASE ONLY, and public-safe by construction.
 *
 * Every function here is reachable without a session, so two rules are enforced
 * in this module rather than left to callers:
 *
 *   NO PRIVATE FIELDS. User rows expose a display name and an avatar. Email,
 *   auth provider and Google subject are never selected, so they cannot leak
 *   through a serialization mistake upstream.
 *
 *   NO FRESH DATA. Leaderboard rows are filtered on `public_after <= now()`.
 *   A snapshot the worker just calculated is invisible until the delay elapses.
 */

export interface ArenaTickerRow {
  rank: number;
  symbol: string;
  companyName: string | null;
  mentions: number;
  mentionSharePct: number | null;
  subredditCount: number | null;
  sentiment: {
    bullishPct: number;
    neutralPct: number;
    bearishPct: number;
    dominant: "bullish" | "neutral" | "bearish" | null;
    classifiedCount: number;
  } | null;
  startPrice: number | null;
  latestPrice: number | null;
  performancePct: number | null;
  trend: { timestamp: string; mentions: number }[];
}

export interface ArenaMeta {
  scope?: ArenaScope;
  period: ArenaPeriod;
  displayMode: string;
  delayMinutes: number;
  sourceSocial: string | null;
  sourceMarket: string | null;
  updatedAt: string | null;
  isMock: boolean;
}

function dominantOf(
  bull: number | null,
  neutral: number | null,
  bear: number | null,
): "bullish" | "neutral" | "bearish" | null {
  if (bull === null || neutral === null || bear === null) return null;
  const max = Math.max(bull, neutral, bear);
  // Ties prefer neutral — claiming a direction the split does not support is
  // worse than reporting that the crowd is divided.
  if (neutral === max) return "neutral";
  return bull === max ? "bullish" : "bearish";
}

/** The newest published batch for a scope + period. */
export async function readTickerRanking(
  scope: ArenaScope,
  period: ArenaPeriod,
  limit: number,
): Promise<{ rows: ArenaTickerRow[]; meta: ArenaMeta }> {
  const newest = await prisma.arenaTickerPerformanceSnapshots.aggregate({
    where: { scope, period },
    _max: { snapshotAt: true },
  });

  const emptyMeta: ArenaMeta = {
    scope,
    period,
    displayMode: "delayed",
    delayMinutes: PUBLIC_DELAY_MINUTES,
    sourceSocial: null,
    sourceMarket: null,
    updatedAt: null,
    isMock: false,
  };

  if (!newest._max.snapshotAt) return { rows: [], meta: emptyMeta };

  const rows = await prisma.arenaTickerPerformanceSnapshots.findMany({
    where: { scope, period, snapshotAt: newest._max.snapshotAt },
    orderBy: { rank: "asc" },
    take: limit,
  });

  // One lookup for the company names rather than a join per row.
  const catalog = await prisma.tickers.findMany({
    where: { ticker: { in: rows.map((r) => r.symbol) } },
    select: { ticker: true, companyName: true },
  });
  const names = new Map(catalog.map((c) => [c.ticker.toUpperCase(), c.companyName]));

  return {
    rows: rows.map((r) => {
      const bull = num(r.bullishPct);
      const neutral = num(r.neutralPct);
      const bear = num(r.bearishPct);
      return {
        rank: r.rank,
        symbol: r.symbol,
        companyName: names.get(r.symbol.toUpperCase()) ?? null,
        mentions: r.mentions,
        mentionSharePct: num(r.mentionSharePct),
        subredditCount: r.subredditCount,
        sentiment:
          bull === null
            ? null
            : {
                bullishPct: bull,
                neutralPct: neutral ?? 0,
                bearishPct: bear ?? 0,
                dominant: dominantOf(bull, neutral, bear),
                classifiedCount: r.classifiedCount ?? 0,
              },
        startPrice: num(r.startPrice),
        latestPrice: num(r.latestPrice),
        performancePct: num(r.performancePct),
        trend: Array.isArray(r.trend)
          ? (r.trend as { timestamp: string; mentions: number }[])
          : [],
      };
    }),
    meta: {
      scope,
      period,
      displayMode: rows[0]?.displayMode ?? "delayed",
      delayMinutes: rows[0]?.delayMinutes ?? PUBLIC_DELAY_MINUTES,
      sourceSocial: rows[0]?.providerSocial ?? null,
      sourceMarket: rows[0]?.providerMarket ?? null,
      updatedAt: newest._max.snapshotAt.toISOString(),
      isMock: rows[0]?.isMock ?? false,
    },
  };
}

export interface ArenaUserRow {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Public Reddit identity, when the user has a VERIFIED one. */
  reddit: { username: string; verificationStatus: string; verifiedAt: string | null } | null;
  returnPct: number;
  portfolioValue: number;
  periodPnL: number;
  bestTicker: string | null;
  bestTradeReturnPct: number | null;
  winRatePct: number | null;
  tradeCount: number;
  maximumDrawdownPct: number | null;
}

export interface LeaderboardMeta {
  period: ArenaPeriod;
  registeredUsers: number;
  eligibleUsers: number;
  rankedUsers: number;
  page: number;
  limit: number;
  displayMode: string;
  delayMinutes: number;
  updatedAt: string | null;
  isMock: boolean;
}

/**
 * The public leaderboard.
 *
 * Reads the newest batch whose `public_after` has already elapsed — so a
 * just-calculated ranking stays invisible for the delay window. Selects only
 * public profile columns.
 */
export async function readLeaderboard(
  period: ArenaPeriod,
  page: number,
  limit: number,
  now: Date = new Date(),
): Promise<{ rows: ArenaUserRow[]; meta: LeaderboardMeta }> {
  const publishable = { period, publicAfter: { lte: now } };

  const [newest, registeredUsers] = await Promise.all([
    prisma.arenaUserPerformanceSnapshots.aggregate({
      where: publishable,
      _max: { calculatedAt: true },
    }),
    prisma.appUsers.count(),
  ]);

  const baseMeta: LeaderboardMeta = {
    period,
    registeredUsers,
    eligibleUsers: 0,
    rankedUsers: 0,
    page,
    limit,
    displayMode: "delayed",
    delayMinutes: PUBLIC_DELAY_MINUTES,
    updatedAt: null,
    isMock: false,
  };

  if (!newest._max.calculatedAt) return { rows: [], meta: baseMeta };

  const batch = { ...publishable, calculatedAt: newest._max.calculatedAt };

  const [rows, rankedUsers] = await Promise.all([
    prisma.arenaUserPerformanceSnapshots.findMany({
      where: batch,
      orderBy: { rank: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        rank: true,
        userId: true,
        returnPct: true,
        portfolioValue: true,
        periodPnl: true,
        bestTicker: true,
        bestTradeReturnPct: true,
        winRatePct: true,
        tradeCount: true,
        maximumDrawdownPct: true,
        isMock: true,
        // Only public profile columns. Email / googleSub / authProvider are
        // deliberately absent so they cannot leak downstream.
        // Reddit verification is public by nature — it is a claim about a
        // public Reddit identity — so the badge can be truthful here instead of
        // rendering "unverified" for everyone by default.
        appUsers: {
          select: {
            displayName: true,
            avatarUrl: true,
            redditAccounts: {
              where: { verificationStatus: "verified" },
              select: { redditUsername: true, verificationStatus: true, verifiedAt: true },
              orderBy: { updatedAt: "desc" },
              take: 1,
            },
          },
        },
      },
    }),
    prisma.arenaUserPerformanceSnapshots.count({ where: batch }),
  ]);

  return {
    rows: rows.map((r) => ({
      rank: r.rank,
      userId: r.userId,
      // No display name yet → a stable anonymous label, never the email local part.
      displayName: r.appUsers.displayName?.trim() || `Trader #${r.rank}`,
      avatarUrl: r.appUsers.avatarUrl ?? null,
      reddit: r.appUsers.redditAccounts[0]
        ? {
            username: r.appUsers.redditAccounts[0].redditUsername,
            verificationStatus: r.appUsers.redditAccounts[0].verificationStatus,
            verifiedAt: r.appUsers.redditAccounts[0].verifiedAt?.toISOString() ?? null,
          }
        : null,
      returnPct: num(r.returnPct) ?? 0,
      portfolioValue: num(r.portfolioValue) ?? 0,
      periodPnL: num(r.periodPnl) ?? 0,
      bestTicker: r.bestTicker,
      bestTradeReturnPct: num(r.bestTradeReturnPct),
      winRatePct: num(r.winRatePct),
      tradeCount: r.tradeCount,
      maximumDrawdownPct: num(r.maximumDrawdownPct),
    })),
    meta: {
      ...baseMeta,
      eligibleUsers: rankedUsers,
      rankedUsers,
      updatedAt: newest._max.calculatedAt.toISOString(),
      isMock: rows[0]?.isMock ?? false,
    },
  };
}

/** Headline figures for the overview cards. */
export async function readSummary(period: ArenaPeriod) {
  const [all, leaderboard] = await Promise.all([
    readTickerRanking("all", period, 10),
    readLeaderboard(period, 1, 1),
  ]);

  const withPerformance = all.rows.filter((r) => r.performancePct !== null);
  const bestTicker =
    withPerformance.length > 0
      ? withPerformance.reduce((best, r) =>
          (r.performancePct ?? 0) > (best.performancePct ?? 0) ? r : best,
        )
      : null;

  return {
    data: {
      totalMentions: all.rows.reduce((s, r) => s + r.mentions, 0),
      eligibleTickers: all.rows.length,
      bestTicker: bestTicker
        ? {
            symbol: bestTicker.symbol,
            performancePct: bestTicker.performancePct,
          }
        : null,
      topTrader: leaderboard.rows[0] ?? null,
      registeredUsers: leaderboard.meta.registeredUsers,
      eligibleUsers: leaderboard.meta.eligibleUsers,
    },
    meta: { ...all.meta, period },
  };
}

/** The signed-in user's own row. Never part of a public response. */
export async function readMyPerformance(userId: string, period: ArenaPeriod) {
  const row = await prisma.arenaUserPerformanceSnapshots.findFirst({
    where: { userId, period },
    orderBy: { calculatedAt: "desc" },
  });
  if (!row) return null;

  return {
    rank: row.rank,
    period,
    returnPct: num(row.returnPct) ?? 0,
    portfolioValue: num(row.portfolioValue) ?? 0,
    periodPnL: num(row.periodPnl) ?? 0,
    winRatePct: num(row.winRatePct),
    tradeCount: row.tradeCount,
    bestTicker: row.bestTicker,
    bestTradeReturnPct: num(row.bestTradeReturnPct),
    calculatedAt: row.calculatedAt.toISOString(),
  };
}
