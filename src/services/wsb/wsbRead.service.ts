import { memoryCache } from "../cache/memoryCache.js";
import {
  readWsbCryptoPositions,
  readWsbOptionPositions,
  readWsbPortfolioSummary,
  readWsbStockPositions,
} from "../../repositories/wsbPortfolio.repository.js";
import {
  readBanbetLeaderboard,
  readBanbetsForUser,
  readBanbetsMeta,
  readExpiringBanbets,
  readResolvedBanbets,
  readBanbetSummary,
  readBanbetTopTickers,
  readBanbetExtremes,
} from "../../repositories/wsbBanbets.repository.js";
import { bucketForFilter } from "./optionDuration.service.js";
import type {
  BanbetSection,
  BanbetSide,
  DurationFilter,
  OptionSort,
  WsbBanbetActivity,
  WsbCryptoPosition,
  WsbOptionPosition,
  WsbPage,
  WsbPortfolioSummary,
  WsbResponseMeta,
  WsbStockPosition,
  WsbTimeframe,
} from "./wsb.types.js";

/**
 * WSB workspace reads — DATABASE ONLY.
 *
 * Same contract as the Pulse read service: this module is reachable from the
 * API process, therefore it may never call Mindcase, Reddit or any other
 * upstream. Everything it returns was computed earlier by a worker job and
 * stored; a filter change narrows a query, it never triggers ingestion.
 *
 * When no snapshot exists yet the response is EMPTY with `updatedAt: null` —
 * not demo data. The portfolio is a claim about real money; inventing one is
 * worse than showing nothing.
 */

/** Aggregation cache over the DB, well under any ingestion interval. */
const READ_CACHE_SECONDS = 30;

const EMPTY_META: WsbResponseMeta = {
  provider: "none",
  source: "database",
  isMock: false,
  updatedAt: null,
};

/** An empty page, used whenever the worker has published nothing yet. */
function emptyPage<T>(page: number, limit: number): WsbPage<T> {
  return { items: [], page, limit, total: 0, hasMore: false };
}

function pageOf<T>(items: T[], page: number, limit: number, total: number): WsbPage<T> {
  return { items, page, limit, total, hasMore: page * limit < total };
}

export async function getWsbPortfolioSummary(timeframe: WsbTimeframe): Promise<{
  data: WsbPortfolioSummary | null;
  meta: WsbResponseMeta;
}> {
  const key = `wsb-summary:${timeframe}`;
  const cached = memoryCache.get<{ data: WsbPortfolioSummary | null; meta: WsbResponseMeta }>(key);
  if (cached) return cached;

  const stored = await readWsbPortfolioSummary(timeframe);
  const result = stored
    ? {
        data: stored.summary,
        meta: {
          provider: stored.meta.provider,
          source: stored.meta.source,
          isMock: stored.meta.isMock,
          updatedAt: stored.meta.snapshotAt,
          ...(stored.meta.warning ? { warning: stored.meta.warning } : {}),
        },
      }
    : { data: null, meta: EMPTY_META };

  memoryCache.set(key, result, READ_CACHE_SECONDS);
  return result;
}

export async function getWsbOptionPositions(params: {
  timeframe: WsbTimeframe;
  duration: DurationFilter;
  page: number;
  limit: number;
  sort: OptionSort;
}): Promise<{ data: WsbPage<WsbOptionPosition>; meta: WsbResponseMeta }> {
  const key = `wsb-options:${params.timeframe}:${params.duration}:${params.sort}:${params.page}:${params.limit}`;
  const cached = memoryCache.get<{ data: WsbPage<WsbOptionPosition>; meta: WsbResponseMeta }>(key);
  if (cached) return cached;

  const { items, total, meta } = await readWsbOptionPositions({
    timeframe: params.timeframe,
    durationBucket: bucketForFilter(params.duration),
    page: params.page,
    limit: params.limit,
    sort: params.sort,
  });

  const result = {
    data: meta ? pageOf(items, params.page, params.limit, total) : emptyPage<WsbOptionPosition>(params.page, params.limit),
    meta: meta
      ? { provider: meta.provider, source: meta.source, isMock: meta.isMock, updatedAt: meta.snapshotAt }
      : EMPTY_META,
  };
  memoryCache.set(key, result, READ_CACHE_SECONDS);
  return result;
}

export async function getWsbStockPositions(params: {
  timeframe: WsbTimeframe;
  page: number;
  limit: number;
}): Promise<{ data: WsbPage<WsbStockPosition>; meta: WsbResponseMeta }> {
  const key = `wsb-stocks:${params.timeframe}:${params.page}:${params.limit}`;
  const cached = memoryCache.get<{ data: WsbPage<WsbStockPosition>; meta: WsbResponseMeta }>(key);
  if (cached) return cached;

  const { items, total, meta } = await readWsbStockPositions(params);
  const result = {
    data: meta ? pageOf(items, params.page, params.limit, total) : emptyPage<WsbStockPosition>(params.page, params.limit),
    meta: meta
      ? { provider: meta.provider, source: meta.source, isMock: meta.isMock, updatedAt: meta.snapshotAt }
      : EMPTY_META,
  };
  memoryCache.set(key, result, READ_CACHE_SECONDS);
  return result;
}

export async function getWsbCryptoPositions(params: {
  timeframe: WsbTimeframe;
  page: number;
  limit: number;
}): Promise<{ data: WsbPage<WsbCryptoPosition>; meta: WsbResponseMeta }> {
  const key = `wsb-crypto:${params.timeframe}:${params.page}:${params.limit}`;
  const cached = memoryCache.get<{ data: WsbPage<WsbCryptoPosition>; meta: WsbResponseMeta }>(key);
  if (cached) return cached;

  const { items, total, meta } = await readWsbCryptoPositions(params);
  const result = {
    data: meta ? pageOf(items, params.page, params.limit, total) : emptyPage<WsbCryptoPosition>(params.page, params.limit),
    meta: meta
      ? { provider: meta.provider, source: meta.source, isMock: meta.isMock, updatedAt: meta.snapshotAt }
      : EMPTY_META,
  };
  memoryCache.set(key, result, READ_CACHE_SECONDS);
  return result;
}

// ── Banbets ──────────────────────────────────────────────────────────────────

export async function getBanbetActivity(params: {
  section: BanbetSection;
  page: number;
  limit: number;
  ticker?: string;
  side?: BanbetSide;
}): Promise<{ data: WsbBanbetActivity; meta: WsbResponseMeta }> {
  const key = `wsb-banbets:${params.section}:${params.page}:${params.limit}:${params.ticker ?? ""}:${params.side ?? ""}`;
  const cached = memoryCache.get<{ data: WsbBanbetActivity; meta: WsbResponseMeta }>(key);
  if (cached) return cached;

  const filters = {
    limit: params.limit,
    skip: (params.page - 1) * params.limit,
    ...(params.ticker ? { ticker: params.ticker } : {}),
    ...(params.side ? { side: params.side } : {}),
  };

  const [recentlyResolved, expiringSoon, meta] = await Promise.all([
    params.section === "expiring" ? Promise.resolve([]) : readResolvedBanbets(filters),
    params.section === "resolved" ? Promise.resolve([]) : readExpiringBanbets(filters),
    readBanbetsMeta(),
  ]);

  const result = {
    data: { recentlyResolved, expiringSoon },
    meta: meta
      ? { provider: meta.provider, source: meta.source, isMock: meta.isMock, updatedAt: meta.updatedAt }
      : EMPTY_META,
  };
  memoryCache.set(key, result, READ_CACHE_SECONDS);
  return result;
}

/**
 * THE OVERVIEW DASHBOARD — one request, every panel.
 *
 * Seven panels on one screen would otherwise be seven round trips that always
 * arrive together, so they are assembled here and cached as a unit. Every
 * figure comes from a database aggregate over the whole table, never from the
 * rows a panel happens to display.
 *
 * Panels are LIMITED to what the dashboard shows (five rows each). "View all"
 * links to the dedicated tabs, which page properly — this endpoint is
 * deliberately not a paging surface.
 */
/**
 * Resolved banbets a user needs before they are ranked at all.
 *
 * Shared by the Overview panel and the Leaderboard tab so the two can never
 * disagree about who counts as established.
 */
export const MIN_LEADERBOARD_BETS = 5;

export async function getBanbetOverview(): Promise<{
  data: {
    summary: Awaited<ReturnType<typeof readBanbetSummary>>;
    active: import("./wsb.types.js").WsbBanbet[];
    recentlyResolved: import("./wsb.types.js").WsbBanbet[];
    topTickers: Awaited<ReturnType<typeof readBanbetTopTickers>>;
    topUsers: Awaited<ReturnType<typeof readBanbetLeaderboard>>;
    biggestGains: Awaited<ReturnType<typeof readBanbetExtremes>>["gains"];
    biggestLosses: Awaited<ReturnType<typeof readBanbetExtremes>>["losses"];
  };
  meta: WsbResponseMeta;
}> {
  const key = "wsb-banbets-overview";
  const cached = memoryCache.get<Awaited<ReturnType<typeof getBanbetOverview>>>(key);
  if (cached) return cached;

  const PANEL_ROWS = 5;

  const [summary, active, recentlyResolved, topTickers, topUsers, extremes, meta] =
    await Promise.all([
      readBanbetSummary(),
      // Nearest deadline first — the ordering lives in the query, so it cannot
      // drift with whatever the client decides to sort by.
      readExpiringBanbets({ limit: PANEL_ROWS, skip: 0 }),
      readResolvedBanbets({ limit: PANEL_ROWS, skip: 0 }),
      readBanbetTopTickers(PANEL_ROWS),
      // The minimum sample size is enforced below, not here: the query returns
      // ranked users and the floor is a presentation rule about who is
      // COMPARABLE, which the dashboard and the Leaderboard tab must share.
      readBanbetLeaderboard(PANEL_ROWS * 4),
      readBanbetExtremes(PANEL_ROWS),
      readBanbetsMeta(),
    ]);

  const result = {
    data: {
      summary,
      active,
      recentlyResolved,
      topTickers,
      // MINIMUM SAMPLE SIZE. One lucky call is not a record, and a user with a
      // single win would otherwise sit at 100% above everyone who has actually
      // played. Applied to RESOLVED bets, because an open bet has proved
      // nothing yet.
      topUsers: topUsers
        .filter((u) => u.resolved >= MIN_LEADERBOARD_BETS)
        .slice(0, PANEL_ROWS),
      biggestGains: extremes.gains,
      biggestLosses: extremes.losses,
    },
    meta: meta
      ? {
          provider: meta.provider,
          source: meta.source,
          isMock: meta.isMock,
          updatedAt: meta.updatedAt,
        }
      : EMPTY_META,
  };

  memoryCache.set(key, result, READ_CACHE_SECONDS);
  return result;
}

/** The signed-in user's own banbets. Never cached — it is per-user data. */
export async function getBanbetsForUser(
  appUserId: string,
  limit: number,
): Promise<{ data: { banbets: import("./wsb.types.js").WsbBanbet[] }; meta: WsbResponseMeta }> {
  const [banbets, meta] = await Promise.all([
    readBanbetsForUser(appUserId, limit),
    readBanbetsMeta(),
  ]);
  return {
    data: { banbets },
    meta: meta
      ? { provider: meta.provider, source: meta.source, isMock: meta.isMock, updatedAt: meta.updatedAt }
      : EMPTY_META,
  };
}

export async function getBanbetBoard(limit: number) {
  const key = `wsb-banbets-board:${limit}`;
  const cached = memoryCache.get<Awaited<ReturnType<typeof readBanbetLeaderboard>>>(key);
  const rows = cached ?? (await readBanbetLeaderboard(limit));
  if (!cached) memoryCache.set(key, rows, READ_CACHE_SECONDS);

  const meta = await readBanbetsMeta();
  return {
    data: { standings: rows },
    meta: meta
      ? { provider: meta.provider, source: meta.source, isMock: meta.isMock, updatedAt: meta.updatedAt }
      : EMPTY_META,
  };
}
