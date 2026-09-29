import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { YOLO_SCORE_CONFIG } from "./yoloScore.config.js";
import { yoloPeriodBounds, type YoloPeriod } from "./yoloPeriods.js";

/**
 * THE ARENA LEADERBOARDS — two of them, never merged.
 *
 * A banbet was made on Reddit under r/wallstreetbets' rules, with an entry
 * price we reconstructed. A YoloBet was made here, with an entry price we
 * froze from a live quote at the moment of placing. Those are different
 * evidentiary standards, so their scores are reported side by side and never
 * summed into a single "total". A combined number would imply the two are
 * commensurable, and they are not.
 *
 * RANKED BY YOLO SCORE, NOT WIN RATE. Win rate answers "how often is this user
 * right?"; the score answers "how impressive were the calls?". Both are shown,
 * because a 90% win rate on trivial targets and a 55% win rate on wild ones are
 * different achievements and neither number alone distinguishes them.
 *
 * A PERIOD IS KEYED ON RESOLUTION. Every aggregate below filters `resolved_at`,
 * not `created_at` — see yoloPeriods for why.
 */

export const BET_TYPES = ["banbet", "yolopulse"] as const;
export type BetType = (typeof BET_TYPES)[number];

export function isBetType(value: unknown): value is BetType {
  return typeof value === "string" && (BET_TYPES as readonly string[]).includes(value);
}

export const BET_STATUS_FILTERS = ["all", "active", "won", "lost"] as const;
export type BetStatusFilter = (typeof BET_STATUS_FILTERS)[number];

export function isBetStatusFilter(value: unknown): value is BetStatusFilter {
  return typeof value === "string" && (BET_STATUS_FILTERS as readonly string[]).includes(value);
}

export interface LeaderboardRow {
  rank: number | null;
  /** Display handle: a Reddit username for banbets, a YOLOPulse name for ours. */
  handle: string;
  userKey: string;
  bets: number;
  wins: number;
  losses: number;
  /** Null rather than 0 when nothing has resolved — "no data" is not "0%". */
  winRate: number | null;
  /** Null when nothing in the window could be scored — never 0. */
  yoloScore: number | null;
  /** How many of this user's bets in the window carry a score. */
  scoredBets: number;
  avgDifficulty: number | null;
  bestBet: {
    ticker: string;
    movePercent: number | null;
    score: number | null;
  } | null;
  currentStreak: number;
  /** "won" | "lost" | null — what the streak is made of. */
  streakKind: "won" | "lost" | null;
  lastBetAt: string | null;
  lastBetStatus: string | null;
  /**
   * True when too few bets have resolved to rank the user honestly. One win
   * out of one bet is not a 100% record, it is an anecdote.
   */
  provisional: boolean;
}

export interface LeaderboardResult {
  rows: LeaderboardRow[];
  meta: {
    type: BetType;
    period: YoloPeriod;
    periodLabel: string;
    periodStart: string | null;
    periodEnd: string;
    total: number;
    page: number;
    pageSize: number;
    minResolvedBetsForRanking: number;
    scoringVersion: string | null;
  };
}

interface AggregateRow {
  user_key: string;
  handle: string | null;
  bets: bigint;
  wins: bigint;
  losses: bigint;
  yolo_score: Prisma.Decimal | null;
  scored_bets: bigint;
  avg_difficulty: Prisma.Decimal | null;
  best_score: Prisma.Decimal | null;
  best_ticker: string | null;
  best_move: Prisma.Decimal | null;
  last_bet_at: Date | null;
  last_bet_status: string | null;
  scoring_version: string | null;
}

/**
 * The aggregate, in ONE SQL statement per ecosystem.
 *
 * Deliberately not "load every bet and reduce in Node": a popular month is tens
 * of thousands of rows, and the ordering has four tie-breakers that Postgres
 * can apply during the sort rather than after transferring everything.
 */
function aggregateSql(type: BetType, start: Date | null, end: Date): Prisma.Sql {
  const windowClause =
    start === null
      ? Prisma.sql`b.resolved_at IS NOT NULL AND b.resolved_at < ${end}`
      : Prisma.sql`b.resolved_at >= ${start} AND b.resolved_at < ${end}`;

  if (type === "yolopulse") {
    return Prisma.sql`
      SELECT
        b.user_id::text AS user_key,
        COALESCE(NULLIF(u.display_name, ''), 'Trader ' || left(b.user_id::text, 6)) AS handle,
        count(*)::bigint AS bets,
        count(*) FILTER (WHERE b.status = 'won')::bigint AS wins,
        count(*) FILTER (WHERE b.status = 'lost')::bigint AS losses,
        COALESCE(sum(b.score_delta), 0) AS yolo_score,
        count(*) FILTER (WHERE b.scoring_version IS NOT NULL)::bigint AS scored_bets,
        avg(b.difficulty) AS avg_difficulty,
        max(b.score_delta) FILTER (WHERE b.status = 'won') AS best_score,
        (array_agg(b.ticker ORDER BY b.score_delta DESC NULLS LAST))[1] AS best_ticker,
        (array_agg(
           abs(b.target_price - b.entry_price) / NULLIF(b.entry_price, 0) * 100
           ORDER BY b.score_delta DESC NULLS LAST))[1] AS best_move,
        max(b.resolved_at) AS last_bet_at,
        (array_agg(b.status ORDER BY b.resolved_at DESC))[1] AS last_bet_status,
        (array_agg(b.scoring_version ORDER BY b.resolved_at DESC))[1] AS scoring_version
      FROM yolo_bets b
      LEFT JOIN app_users u ON u.id = b.user_id
      WHERE ${windowClause}
        AND b.status IN ('won','lost')
      GROUP BY b.user_id, u.display_name`;
  }

  // BANBETS. Only `confirmed` rows count: a bare !banbet comment is a
  // candidate until the WSB bot's reply shows the bet was accepted, and
  // scoring unaccepted comments would invent a record nobody kept.
  return Prisma.sql`
    SELECT
      b.username_hash AS user_key,
      COALESCE(b.display_username, 'Redditor ' || left(b.username_hash, 6)) AS handle,
      count(*)::bigint AS bets,
      count(*) FILTER (WHERE b.status = 'won')::bigint AS wins,
      count(*) FILTER (WHERE b.status IN ('lost','expired'))::bigint AS losses,
      COALESCE(sum(b.score_delta), 0) AS yolo_score,
      count(*) FILTER (WHERE b.scoring_version IS NOT NULL)::bigint AS scored_bets,
      avg(b.difficulty) AS avg_difficulty,
      max(b.score_delta) FILTER (WHERE b.status = 'won') AS best_score,
      (array_agg(b.ticker ORDER BY b.score_delta DESC NULLS LAST))[1] AS best_ticker,
      (array_agg(
         abs(b.target_price - b.entry_price) / NULLIF(b.entry_price, 0) * 100
         ORDER BY b.score_delta DESC NULLS LAST))[1] AS best_move,
      max(b.resolved_at) AS last_bet_at,
      (array_agg(b.status ORDER BY b.resolved_at DESC))[1] AS last_bet_status,
      (array_agg(b.scoring_version ORDER BY b.resolved_at DESC))[1] AS scoring_version
    FROM wsb_banbets b
    WHERE ${windowClause}
      AND b.confirmation = 'confirmed'
      AND b.status IN ('won','lost','expired')
    GROUP BY b.username_hash, b.display_username`;
}

const toNumber = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));

export async function readYoloLeaderboard(params: {
  type: BetType;
  period: YoloPeriod;
  page?: number;
  pageSize?: number;
  search?: string;
  now?: Date;
}): Promise<LeaderboardResult> {
  const { type, period } = params;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const window = yoloPeriodBounds(period, params.now ?? new Date());

  const rows = await prisma.$queryRaw<AggregateRow[]>(aggregateSql(type, window.start, window.end));

  const search = params.search?.trim().toLowerCase() ?? "";
  const filtered = search
    ? rows.filter(
        (r) =>
          (r.handle ?? "").toLowerCase().includes(search) ||
          (r.best_ticker ?? "").toLowerCase().includes(search),
      )
    : rows;

  const mapped = filtered.map((r) => {
    const bets = Number(r.bets);
    const wins = Number(r.wins);
    const losses = Number(r.losses);
    const resolved = wins + losses;
    return {
      userKey: r.user_key,
      handle: r.handle ?? r.user_key.slice(0, 8),
      bets,
      wins,
      losses,
      // NULL, not 0, when nothing resolved. "0%" is a claim about a record
      // that does not exist.
      winRate: resolved > 0 ? Math.round((wins / resolved) * 1000) / 10 : null,
      // NULL, NOT ZERO, when none of this user's bets could be scored. A
      // banbet whose entry price or volatility could not be reconstructed has
      // no score; printing "0" would say the calls were worthless rather than
      // unmeasured, and would sort an unscored veteran below a single lucky win.
      yoloScore: Number(r.scored_bets) > 0 ? Math.round(Number(r.yolo_score ?? 0) * 100) / 100 : null,
      scoredBets: Number(r.scored_bets),
      avgDifficulty: (() => {
        const d = toNumber(r.avg_difficulty);
        return d === null ? null : Math.round(d * 100) / 100;
      })(),
      bestBet: r.best_ticker
        ? {
            ticker: r.best_ticker,
            movePercent: (() => {
              const m = toNumber(r.best_move);
              return m === null ? null : Math.round(m * 10) / 10;
            })(),
            score: (() => {
              const s = toNumber(r.best_score);
              return s === null ? null : Math.round(s * 100) / 100;
            })(),
          }
        : null,
      // Streaks need per-bet ordering, which the aggregate deliberately does
      // not carry; filled in below for the visible page only.
      currentStreak: 0,
      streakKind: null as "won" | "lost" | null,
      lastBetAt: r.last_bet_at?.toISOString() ?? null,
      lastBetStatus: r.last_bet_status,
      provisional: resolved < YOLO_SCORE_CONFIG.minResolvedBetsForRanking,
      scoringVersion: r.scoring_version,
    };
  });

  /**
   * ORDERING. Score first; the tie-breakers exist because a tie on score with
   * no further rule would order users by whatever Postgres happened to return,
   * and a leaderboard that reshuffles on refresh is not a leaderboard.
   *
   * Provisional users are sorted BELOW every ranked one regardless of score:
   * one lucky bet must never top the board.
   */
  mapped.sort((a, b) => {
    if (a.provisional !== b.provisional) return a.provisional ? 1 : -1;
    // An unscored record sorts below every scored one: it is not a zero, it is
    // an unknown, and an unknown cannot outrank a measurement.
    const aScored = a.yoloScore !== null;
    const bScored = b.yoloScore !== null;
    if (aScored !== bScored) return aScored ? -1 : 1;
    if (aScored && bScored && b.yoloScore !== a.yoloScore) {
      return (b.yoloScore as number) - (a.yoloScore as number);
    }
    if (b.wins !== a.wins) return b.wins - a.wins;
    const ad = a.avgDifficulty ?? 0;
    const bd = b.avgDifficulty ?? 0;
    if (bd !== ad) return bd - ad;
    const aw = a.winRate ?? 0;
    const bw = b.winRate ?? 0;
    if (bw !== aw) return bw - aw;
    return b.wins + b.losses - (a.wins + a.losses);
  });

  const total = mapped.length;
  const start = (page - 1) * pageSize;
  const visible = mapped.slice(start, start + pageSize);

  const streaks = await currentStreaks(
    type,
    visible.map((v) => v.userKey),
    window.end,
  );

  const rowsOut: LeaderboardRow[] = visible.map((v, i) => {
    const streak = streaks.get(v.userKey);
    return {
      // A provisional user carries NO rank number — showing "#1 (provisional)"
      // still reads as first place at a glance.
      rank: v.provisional ? null : start + i + 1,
      handle: v.handle,
      userKey: v.userKey,
      bets: v.bets,
      wins: v.wins,
      losses: v.losses,
      winRate: v.winRate,
      yoloScore: v.yoloScore,
      scoredBets: v.scoredBets,
      avgDifficulty: v.avgDifficulty,
      bestBet: v.bestBet,
      currentStreak: streak?.count ?? 0,
      streakKind: streak?.kind ?? null,
      lastBetAt: v.lastBetAt,
      lastBetStatus: v.lastBetStatus,
      provisional: v.provisional,
    };
  });

  return {
    rows: rowsOut,
    meta: {
      type,
      period,
      periodLabel: window.label,
      periodStart: window.start?.toISOString() ?? null,
      periodEnd: window.end.toISOString(),
      total,
      page,
      pageSize,
      minResolvedBetsForRanking: YOLO_SCORE_CONFIG.minResolvedBetsForRanking,
      scoringVersion: visible[0]?.scoringVersion ?? null,
    },
  };
}

/**
 * The current run of wins or losses, most recent first.
 *
 * Computed only for the rows actually on screen. A streak is per-bet ordering
 * information that the group-by cannot produce, and computing it for every
 * user in a long window to show twenty-five of them would be most of the
 * query's cost spent on rows nobody sees.
 */
async function currentStreaks(
  type: BetType,
  userKeys: string[],
  before: Date,
): Promise<Map<string, { count: number; kind: "won" | "lost" }>> {
  const out = new Map<string, { count: number; kind: "won" | "lost" }>();
  if (userKeys.length === 0) return out;

  const rows =
    type === "yolopulse"
      ? await prisma.$queryRaw<{ user_key: string; status: string }[]>(Prisma.sql`
          SELECT user_id::text AS user_key, status
            FROM yolo_bets
           WHERE user_id::text IN (${Prisma.join(userKeys)})
             AND status IN ('won','lost')
             AND resolved_at IS NOT NULL AND resolved_at < ${before}
           ORDER BY user_id, resolved_at DESC`)
      : await prisma.$queryRaw<{ user_key: string; status: string }[]>(Prisma.sql`
          SELECT username_hash AS user_key, status
            FROM wsb_banbets
           WHERE username_hash IN (${Prisma.join(userKeys)})
             AND confirmation = 'confirmed'
             AND status IN ('won','lost','expired')
             AND resolved_at IS NOT NULL AND resolved_at < ${before}
           ORDER BY username_hash, resolved_at DESC`);

  // Rows arrive newest-first per user. The streak is the LEADING run: count
  // while the result matches the most recent one, then stop for that user.
  const closed = new Set<string>();
  for (const row of rows) {
    if (closed.has(row.user_key)) continue;
    const kind: "won" | "lost" = row.status === "won" ? "won" : "lost";
    const existing = out.get(row.user_key);
    if (!existing) {
      out.set(row.user_key, { count: 1, kind });
      continue;
    }
    if (existing.kind === kind) existing.count += 1;
    else closed.add(row.user_key);
  }

  return out;
}

export interface ArenaSummaryCards {
  totalBets: number;
  activeBets: number;
  participants: number;
  /** Resolution rate for banbets; highest score for YOLOPulse. */
  resolutionRate: number | null;
  highestYoloScore: number | null;
}

/** The four cards above the table. Window-scoped like the board itself. */
export async function readArenaSummary(
  type: BetType,
  period: YoloPeriod,
  now: Date = new Date(),
): Promise<ArenaSummaryCards> {
  const window = yoloPeriodBounds(period, now);
  const createdClause =
    window.start === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`created_at >= ${window.start} AND created_at < ${window.end}`;

  if (type === "yolopulse") {
    const [row] = await prisma.$queryRaw<
      { total: bigint; active: bigint; traders: bigint; best: Prisma.Decimal | null }[]
    >(Prisma.sql`
      SELECT count(*)::bigint AS total,
             count(*) FILTER (WHERE status = 'active')::bigint AS active,
             count(DISTINCT user_id)::bigint AS traders,
             max(score_delta) AS best
        FROM yolo_bets
       WHERE ${createdClause}`);
    return {
      totalBets: Number(row?.total ?? 0),
      activeBets: Number(row?.active ?? 0),
      participants: Number(row?.traders ?? 0),
      resolutionRate: null,
      highestYoloScore: row?.best === null || row?.best === undefined ? null : Number(row.best),
    };
  }

  const [row] = await prisma.$queryRaw<
    { total: bigint; active: bigint; users: bigint; resolved: bigint }[]
  >(Prisma.sql`
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE status = 'open')::bigint AS active,
           count(DISTINCT username_hash)::bigint AS users,
           count(*) FILTER (WHERE status IN ('won','lost','expired'))::bigint AS resolved
      FROM wsb_banbets
     WHERE ${createdClause}`);

  const total = Number(row?.total ?? 0);
  const resolved = Number(row?.resolved ?? 0);
  return {
    totalBets: total,
    activeBets: Number(row?.active ?? 0),
    participants: Number(row?.users ?? 0),
    // Null, not 0, when there is nothing to take a percentage of.
    resolutionRate: total > 0 ? Math.round((resolved / total) * 1000) / 10 : null,
    highestYoloScore: null,
  };
}
