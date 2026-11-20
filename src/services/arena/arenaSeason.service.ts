import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import {
  ARENA_TIME_ZONE,
  wallClockInZone,
  yoloPeriodBounds,
  type PeriodWindow,
  type YoloPeriod,
} from "./yoloPeriods.js";

/**
 * THE ARENA SEASON — derived from the Arena itself, never declared.
 *
 * WHAT A SEASON IS. The YOLO Arena has no admin-run season table. What it does
 * have is a default board: `GET /api/arena/leaderboard` ranks the MONTHLY window
 * unless asked otherwise, and /competition opens on it. That window — 00:00 New
 * York time on the 1st up to (not including) 00:00 on the 1st of the next month,
 * standings keyed on resolution — is the season. This module names it; it does
 * not invent a second calendar beside the one the boards already use, so the
 * Dashboard promo, the leaderboard and any countdown can never disagree about
 * when the season ends.
 *
 * WHY NOT `competitions`. That table is the retired paper-trading league: one
 * seeded row whose window closed in August and which the Arena page no longer
 * reads. Presenting it as "the Arena season" would show a dead league as live.
 *
 * NO SEASON NUMBER. A number needs an epoch ("season 1 began …") that nobody
 * has defined; printing one would be making it up. The month is the name.
 *
 * DATABASE ONLY. The window is arithmetic on the clock; the activity is counted
 * from stored bets. Nothing here can reach a provider, so a Dashboard visit
 * costs one round trip to Postgres and nothing upstream.
 */

/** The Arena board that defines the season. */
export const ARENA_SEASON_PERIOD = "monthly" as const satisfies YoloPeriod;

export type ArenaSeasonStatus = "open" | "closed";

export interface ArenaSeasonWindow {
  /** Stable id of the season, e.g. "2026-11". */
  key: string;
  /** "November 2026" — the same label the monthly board prints. */
  label: string;
  /** "NOV 2026" — short enough for the pixel headline. */
  shortLabel: string;
  /** Which Arena board this season is. */
  board: typeof ARENA_SEASON_PERIOD;
  /** The zone the window is drawn in. */
  timeZone: string;
  /** Inclusive start (ISO). */
  startsAt: string;
  /** EXCLUSIVE end (ISO) — the first instant of the next season. */
  endsAt: string;
  /** `open` while startsAt <= now < endsAt. */
  status: ArenaSeasonStatus;
  /** Share of the window elapsed at `asOf`, 0..100, one decimal. */
  elapsedPct: number;
}

/**
 * One contest's activity in the season. The two contests are reported side by
 * side and never added together — see yoloLeaderboard.service for why.
 */
export interface ContestSeasonActivity {
  /** Bets placed inside the season window. */
  placed: number;
  /** Bets still in play right now, whenever they were placed. */
  open: number;
  /** Bets settled inside the window — exactly what the season's board ranks. */
  settled: number;
  /** Distinct users with at least one settled bet this season — the board's size. */
  competitors: number;
}

export interface ArenaSeasonView {
  season: ArenaSeasonWindow;
  contests: {
    /** r/wallstreetbets banbets — CONFIRMED rows only, as on the board. */
    banbet: ContestSeasonActivity;
    /** Predictions placed inside YOLOPulse. */
    yolopulse: ContestSeasonActivity;
  };
  meta: {
    /** When the window was evaluated and the bets counted. */
    asOf: string;
    /** Counts are read live from stored bets — there is no snapshot to age. */
    source: "database";
  };
}

const MONTH_SHORT = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/**
 * The season block for a window, evaluated at `now`.
 *
 * Pure: the clock is a parameter, so the status, the progress and the DST edges
 * are testable without waiting for a month to end.
 */
export function describeSeason(window: PeriodWindow, now: Date): ArenaSeasonWindow {
  if (window.start === null) {
    // "All time" has no end to count down to and cannot be a season.
    throw new Error("An Arena season needs a bounded window.");
  }

  // The calendar month is read in New York, not UTC: 04:00Z on the 1st is
  // still the previous month's last evening in UTC terms but already the new
  // month on the board. Noon is safely inside the first day either way.
  const local = wallClockInZone(new Date(window.start.getTime() + 12 * 3_600_000));

  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  const nowMs = now.getTime();
  const open = nowMs >= startMs && nowMs < endMs;
  const elapsed = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));

  return {
    key: `${local.year}-${String(local.month).padStart(2, "0")}`,
    label: window.label,
    shortLabel: `${MONTH_SHORT[local.month - 1]} ${local.year}`,
    board: ARENA_SEASON_PERIOD,
    timeZone: ARENA_TIME_ZONE,
    startsAt: window.start.toISOString(),
    endsAt: window.end.toISOString(),
    status: open ? "open" : "closed",
    elapsedPct: Math.round(elapsed * 1000) / 10,
  };
}

/** What one counting query returns. Postgres hands `count(*)` back as bigint. */
export interface ActivityCountsRow {
  placed: bigint | number;
  open: bigint | number;
  settled: bigint | number;
  competitors: bigint | number;
}

/**
 * A counts row → the DTO.
 *
 * An aggregate without GROUP BY always returns exactly one row, so a missing
 * row means the query did not run as written. That is an error to surface, NOT
 * a season with zero bets in it — "nothing happened" and "we could not count"
 * are different facts.
 */
export function toActivity(row: ActivityCountsRow | undefined): ContestSeasonActivity {
  if (!row) throw new Error("Arena season activity query returned no row.");
  return {
    placed: Number(row.placed),
    open: Number(row.open),
    settled: Number(row.settled),
    competitors: Number(row.competitors),
  };
}

/** The whole view, from a window and the two counts rows. Pure. */
export function assembleArenaSeason(input: {
  now: Date;
  window: PeriodWindow;
  banbet: ActivityCountsRow | undefined;
  yolopulse: ActivityCountsRow | undefined;
}): ArenaSeasonView {
  return {
    season: describeSeason(input.window, input.now),
    contests: {
      banbet: toActivity(input.banbet),
      yolopulse: toActivity(input.yolopulse),
    },
    meta: { asOf: input.now.toISOString(), source: "database" },
  };
}

/**
 * YOLOPulse bets. "Settled" means won or lost inside the window — the same
 * filter the board aggregates on, so `competitors` matches its row count.
 * A cancelled bet is neither in play nor settled.
 */
function yolopulseCountsSql(start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE created_at >= ${start} AND created_at < ${end})::bigint AS placed,
      count(*) FILTER (WHERE status = 'active')::bigint AS open,
      count(*) FILTER (
        WHERE status IN ('won','lost') AND resolved_at >= ${start} AND resolved_at < ${end}
      )::bigint AS settled,
      count(DISTINCT user_id) FILTER (
        WHERE status IN ('won','lost') AND resolved_at >= ${start} AND resolved_at < ${end}
      )::bigint AS competitors
    FROM yolo_bets`;
}

/**
 * Banbets. Only CONFIRMED rows — a bare !banbet comment is a candidate until
 * the WSB bot's reply accepts it, and the board ignores candidates too. Rows
 * flagged as mock never count.
 */
function banbetCountsSql(start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE created_at >= ${start} AND created_at < ${end})::bigint AS placed,
      count(*) FILTER (WHERE status = 'open')::bigint AS open,
      count(*) FILTER (
        WHERE status IN ('won','lost','expired') AND resolved_at >= ${start} AND resolved_at < ${end}
      )::bigint AS settled,
      count(DISTINCT username_hash) FILTER (
        WHERE status IN ('won','lost','expired') AND resolved_at >= ${start} AND resolved_at < ${end}
      )::bigint AS competitors
    FROM wsb_banbets
    WHERE confirmation = 'confirmed'
      AND is_mock = false`;
}

/** Runs one counting statement. Injectable so tests need no database. */
export type CountsQuery = (sql: Prisma.Sql) => Promise<ActivityCountsRow[]>;

const queryCounts: CountsQuery = (sql) => prisma.$queryRaw<ActivityCountsRow[]>(sql);

/**
 * The current season and what has happened in it.
 *
 * A database failure propagates (→ 500) so the panel can say the season is
 * unavailable instead of drawing an empty-looking but "open" arena.
 */
export async function readArenaSeason(
  now: Date = new Date(),
  query: CountsQuery = queryCounts,
): Promise<ArenaSeasonView> {
  const window = yoloPeriodBounds(ARENA_SEASON_PERIOD, now);
  const start = window.start;
  if (start === null) throw new Error("An Arena season needs a bounded window.");

  const [banbetRows, yolopulseRows] = await Promise.all([
    query(banbetCountsSql(start, window.end)),
    query(yolopulseCountsSql(start, window.end)),
  ]);

  return assembleArenaSeason({
    now,
    window,
    banbet: banbetRows[0],
    yolopulse: yolopulseRows[0],
  });
}
