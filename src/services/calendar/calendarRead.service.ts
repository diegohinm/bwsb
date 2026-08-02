import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { num } from "../../lib/numeric.js";
import { TRACKED_SUBREDDIT_NAMES } from "../social/subreddits.js";
import {
  MARKET_TIMEZONE,
  MAX_PERSONAL_TICKERS,
  PUBLIC_DELAY_MINUTES,
  publicPriceCutoff,
  toDateKey,
  type EarningsStatus,
  type EarningsTiming,
  type SocialTimeframe,
} from "./calendarVocabulary.js";
import { rankTrendingTickers, type TrendingTicker } from "./trendingTickers.service.js";

/**
 * CALENDAR READ SERVICE — the API's only path to earnings data.
 *
 * Every function here reads Postgres. None of them can reach the earnings
 * provider: that is the worker's job, and it is what keeps a page view from
 * costing an upstream request no matter how many people open the calendar or
 * how often they change a filter.
 */

export const EARNINGS_JOB_NAME = "refreshEarningsCalendar";

export type CalendarEvent = {
  id: string;
  symbol: string;
  companyName: string | null;
  reportDate: string;
  reportTime: string | null;
  timing: EarningsTiming;
  status: EarningsStatus;
  fiscalQuarter: string | null;
  fiscalYear: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  /** Null outside the trending mode, or when the symbol went unmentioned. */
  mentionCount: number | null;
  mentionRank: number | null;
  sentiment: TrendingTicker["sentiment"];
  /** Delayed price. Null when no eligible quote exists — never a zero. */
  price: number | null;
  displayMode: "delayed";
  delayMinutes: number;
  provider: string;
  source: string | null;
  isMock: boolean;
};

export type CalendarMeta = {
  start: string;
  end: string;
  mode: "reddit_trending" | "personal" | "symbol";
  timezone: string;
  socialTimeframe: SocialTimeframe | null;
  subreddits: string[] | null;
  /** The symbols the calendar was built for — proof it is not a fixed list. */
  symbols: string[];
  sourceEarnings: string | null;
  sourceSocial: string | null;
  sourceMarket: string | null;
  updatedAt: string | null;
  isMock: boolean;
  /** True when the last refresh is older than two intervals, or never ran. */
  stale: boolean;
  /** False when no earnings provider is configured — the honest empty state. */
  providerConfigured: boolean;
  displayMode: "delayed";
  delayMinutes: number;
};

type EventFilters = {
  status?: EarningsStatus | "all";
  timing?: EarningsTiming | "all";
};

/** Newest publicly quotable price per symbol, batched into two queries. */
async function delayedPrices(
  symbols: string[],
  now: Date,
): Promise<{ prices: Map<string, number>; provider: string | null }> {
  const prices = new Map<string, number>();
  if (symbols.length === 0) return { prices, provider: null };

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
  if (bounds.length === 0) return { prices, provider: null };

  const instants = bounds
    .map((b) => b._max.observedAt)
    .filter((d): d is Date => Boolean(d));
  const rows = await prisma.marketQuoteSnapshots.findMany({
    where: { symbol: { in: symbols }, observedAt: { in: instants } },
    select: { symbol: true, price: true, provider: true, observedAt: true },
  });

  const newest = new Map<string, { at: number; price: number | null; provider: string | null }>();
  for (const r of rows) {
    const at = r.observedAt?.getTime() ?? 0;
    const current = newest.get(r.symbol);
    if (!current || at > current.at) {
      newest.set(r.symbol, { at, price: num(r.price), provider: r.provider });
    }
  }

  let provider: string | null = null;
  for (const [symbol, v] of newest) {
    if (v.price !== null) prices.set(symbol, v.price);
    provider ??= v.provider;
  }
  return { prices, provider };
}

/** Whether the stored calendar is behind, and when it was last refreshed. */
async function freshness(): Promise<{ updatedAt: string | null; stale: boolean }> {
  const lastSuccess = await prisma.workerRuns.findFirst({
    where: {
      jobName: EARNINGS_JOB_NAME,
      status: { in: ["success", "success_without_change"] },
    },
    orderBy: { createdAt: "desc" },
    select: { finishedAt: true, createdAt: true },
  });

  const at = lastSuccess?.finishedAt ?? lastSuccess?.createdAt ?? null;
  if (!at) return { updatedAt: null, stale: true };

  // Two intervals of grace: one missed tick is normal, two means the provider
  // or the worker has a problem the page should admit to.
  const staleAfterMs = env.EARNINGS_REFRESH_SECONDS * 2 * 1000;
  return {
    updatedAt: at.toISOString(),
    stale: Date.now() - at.getTime() > staleAfterMs,
  };
}

type Row = Awaited<ReturnType<typeof queryEvents>>[number];

async function queryEvents(
  symbols: string[],
  start: Date,
  end: Date,
  filters: EventFilters,
) {
  if (symbols.length === 0) return [];
  const status = filters.status && filters.status !== "all" ? filters.status : undefined;
  const timing = filters.timing && filters.timing !== "all" ? filters.timing : undefined;

  return prisma.earningsEvents.findMany({
    where: {
      symbol: { in: symbols },
      reportDate: { gte: start, lte: end },
      ...(status ? { status } : {}),
      ...(timing ? { timing } : {}),
    },
    orderBy: [{ reportDate: "asc" }, { symbol: "asc" }],
  });
}

function toEvent(
  row: Row,
  trending: Map<string, TrendingTicker> | null,
  prices: Map<string, number>,
): CalendarEvent {
  const t = trending?.get(row.symbol) ?? null;
  return {
    id: row.id,
    symbol: row.symbol,
    companyName: row.companyName,
    reportDate: toDateKey(row.reportDate),
    reportTime: row.reportTime ? row.reportTime.toISOString() : null,
    timing: row.timing as EarningsTiming,
    status: row.status as EarningsStatus,
    fiscalQuarter: row.fiscalQuarter,
    fiscalYear: row.fiscalYear,
    epsEstimate: num(row.epsEstimate),
    epsActual: num(row.epsActual),
    revenueEstimate: num(row.revenueEstimate),
    revenueActual: num(row.revenueActual),
    mentionCount: t?.mentions ?? null,
    mentionRank: t?.rank ?? null,
    sentiment: t?.sentiment ?? null,
    price: prices.get(row.symbol) ?? null,
    displayMode: "delayed",
    delayMinutes: PUBLIC_DELAY_MINUTES,
    provider: row.provider,
    source: row.source,
    isMock: row.isMock,
  };
}

/** Shared tail: attach prices, shape rows, assemble meta. */
async function assemble(options: {
  rows: Row[];
  symbols: string[];
  start: Date;
  end: Date;
  mode: CalendarMeta["mode"];
  trending: Map<string, TrendingTicker> | null;
  socialTimeframe: SocialTimeframe | null;
  subreddits: string[] | null;
  sourceSocial: string | null;
  now: Date;
}): Promise<{ data: CalendarEvent[]; meta: CalendarMeta }> {
  const { rows, symbols, start, end, mode, trending, socialTimeframe, subreddits, sourceSocial, now } =
    options;

  const present = [...new Set(rows.map((r) => r.symbol))];
  const [{ prices, provider: sourceMarket }, fresh] = await Promise.all([
    delayedPrices(present, now),
    freshness(),
  ]);

  const data = rows.map((r) => toEvent(r, trending, prices));
  const providers = [...new Set(rows.map((r) => r.provider))];

  return {
    data,
    meta: {
      start: toDateKey(start),
      end: toDateKey(end),
      mode,
      timezone: MARKET_TIMEZONE,
      socialTimeframe,
      subreddits,
      symbols,
      sourceEarnings: providers.length > 0 ? providers.join(",") : null,
      sourceSocial,
      sourceMarket,
      updatedAt: fresh.updatedAt,
      // One mock event makes the whole view demo data — a partly-real calendar
      // that is not labelled is the case this flag exists to prevent.
      isMock: rows.some((r) => r.isMock),
      stale: fresh.stale,
      providerConfigured: env.EARNINGS_DATA_PROVIDER !== "none",
      displayMode: "delayed",
      delayMinutes: PUBLIC_DELAY_MINUTES,
    },
  };
}

/**
 * THE PUBLIC CALENDAR. No session required.
 *
 * Its symbol set is derived, every request, from Reddit mention aggregates in
 * the selected window and communities — which is why changing a filter changes
 * the calendar without any provider involvement.
 */
export async function readPublicCalendar(options: {
  start: Date;
  end: Date;
  socialTimeframe: SocialTimeframe;
  subreddits?: string[];
  limitTickers: number;
  filters: EventFilters;
  now?: Date;
}): Promise<{ data: CalendarEvent[]; meta: CalendarMeta }> {
  const { start, end, socialTimeframe, limitTickers, filters, now = new Date() } = options;
  const subreddits = options.subreddits ?? [...TRACKED_SUBREDDIT_NAMES];

  const trend = await rankTrendingTickers({
    timeframe: socialTimeframe,
    subreddits,
    limit: limitTickers,
    now,
  });
  const symbols = trend.tickers.map((t) => t.symbol);
  const trending = new Map(trend.tickers.map((t) => [t.symbol, t]));
  const rows = await queryEvents(symbols, start, end, filters);

  return assemble({
    rows,
    symbols,
    start,
    end,
    mode: "reddit_trending",
    trending,
    socialTimeframe,
    subreddits,
    sourceSocial: trend.sourceSocial,
    now,
  });
}

/** Every stored event for one symbol in a range. Public. */
export async function readSymbolCalendar(
  symbol: string,
  options: { start: Date; end: Date; now?: Date },
): Promise<{ data: CalendarEvent[]; meta: CalendarMeta }> {
  const upper = symbol.toUpperCase();
  const now = options.now ?? new Date();
  const rows = await queryEvents([upper], options.start, options.end, {});

  // Mentions for a single symbol still come from the aggregate, so the detail
  // panel can show the same figure the calendar showed.
  const trend = await rankTrendingTickers({ timeframe: "7d", limit: 200, now });
  const match = trend.tickers.find((t) => t.symbol === upper) ?? null;

  return assemble({
    rows,
    symbols: [upper],
    start: options.start,
    end: options.end,
    mode: "symbol",
    trending: match ? new Map([[upper, match]]) : null,
    socialTimeframe: "7d",
    subreddits: null,
    sourceSocial: trend.sourceSocial,
    now,
  });
}

// ── Personalization ─────────────────────────────────────────────────────────

export type CalendarPreferences = {
  selectedTickers: string[];
  includeWatchlist: boolean;
  includeVirtualPositions: boolean;
  includeTrendingTickers: boolean;
  defaultView: string;
  timezone: string;
};

export const DEFAULT_PREFERENCES: CalendarPreferences = {
  selectedTickers: [],
  includeWatchlist: true,
  includeVirtualPositions: true,
  includeTrendingTickers: false,
  defaultView: "month",
  timezone: MARKET_TIMEZONE,
};

/** A user's stored preferences, or the defaults when they have never saved. */
export async function readPreferences(userId: string): Promise<CalendarPreferences> {
  const row = await prisma.userCalendarPreferences.findUnique({ where: { userId } });
  if (!row) return { ...DEFAULT_PREFERENCES };
  return {
    selectedTickers: row.selectedTickers,
    includeWatchlist: row.includeWatchlist,
    includeVirtualPositions: row.includeVirtualPositions,
    includeTrendingTickers: row.includeTrendingTickers,
    defaultView: row.defaultView,
    timezone: row.timezone,
  };
}

export async function writePreferences(
  userId: string,
  next: CalendarPreferences,
): Promise<CalendarPreferences> {
  const row = await prisma.userCalendarPreferences.upsert({
    where: { userId },
    create: { userId, ...next },
    update: next,
  });
  return {
    selectedTickers: row.selectedTickers,
    includeWatchlist: row.includeWatchlist,
    includeVirtualPositions: row.includeVirtualPositions,
    includeTrendingTickers: row.includeTrendingTickers,
    defaultView: row.defaultView,
    timezone: row.timezone,
  };
}

export type PersonalSources = {
  selected: string[];
  watchlist: string[];
  positions: string[];
  trending: string[];
};

/**
 * The symbols a signed-in user's calendar is built from, and where each came
 * from — the panel shows the breakdown so "why is TSLA here?" has an answer.
 */
export async function resolvePersonalSymbols(
  userId: string,
  prefs: CalendarPreferences,
  now: Date = new Date(),
): Promise<{ symbols: string[]; sources: PersonalSources }> {
  const selected = prefs.selectedTickers.map((s) => s.toUpperCase());

  const watchlist = prefs.includeWatchlist
    ? (
        await prisma.userWatchlistItems.findMany({
          where: { userWatchlists: { userId } },
          select: { ticker: true },
        })
      ).map((r) => r.ticker.toUpperCase())
    : [];

  const positions = prefs.includeVirtualPositions
    ? (
        await prisma.virtualPositions.findMany({
          where: { userId, ticker: { not: null } },
          select: { ticker: true },
        })
      )
        .map((r) => r.ticker)
        .filter((t): t is string => Boolean(t))
        .map((t) => t.toUpperCase())
    : [];

  const trending = prefs.includeTrendingTickers
    ? (await rankTrendingTickers({ timeframe: "7d", limit: 20, now })).tickers.map(
        (t) => t.symbol,
      )
    : [];

  const symbols = [
    ...new Set([...selected, ...watchlist, ...positions, ...trending]),
  ].slice(0, MAX_PERSONAL_TICKERS + 50);

  return {
    symbols,
    sources: {
      selected,
      watchlist: [...new Set(watchlist)],
      positions: [...new Set(positions)],
      trending,
    },
  };
}

/** The signed-in user's own calendar. Never public. */
export async function readPersonalCalendar(
  userId: string,
  options: { start: Date; end: Date; filters: EventFilters; now?: Date },
): Promise<{
  data: CalendarEvent[];
  meta: CalendarMeta & { sources: PersonalSources; preferences: CalendarPreferences };
}> {
  const now = options.now ?? new Date();
  const preferences = await readPreferences(userId);
  const { symbols, sources } = await resolvePersonalSymbols(userId, preferences, now);
  const rows = await queryEvents(symbols, options.start, options.end, options.filters);

  const assembled = await assemble({
    rows,
    symbols,
    start: options.start,
    end: options.end,
    mode: "personal",
    trending: null,
    socialTimeframe: null,
    subreddits: null,
    sourceSocial: null,
    now,
  });

  return { data: assembled.data, meta: { ...assembled.meta, sources, preferences } };
}
