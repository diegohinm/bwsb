/**
 * ARENA RANKING PERIODS — daily, weekly, monthly, all time.
 *
 * TWO DECISIONS LIVE HERE, and both are easy to get quietly wrong.
 *
 * 1. A PERIOD IS KEYED ON RESOLUTION, NOT CREATION. A bet placed on 30 August
 *    and settled on 2 September belongs to September. Keying on creation would
 *    mean a month's leaderboard keeps changing after the month ends, and a bet
 *    with a long horizon would score in a month whose result was unknowable at
 *    the time. The caller enforces this by filtering on `resolvedAt`; this
 *    module only supplies the window.
 *
 * 2. THE CLOCK IS AMERICA/NEW_YORK, not UTC. "Today" on a market leaderboard
 *    means the trading day, and UTC midnight falls at 8pm the previous evening
 *    in New York — so a UTC day would close the board mid-session and bleed
 *    each session across two "days". Weeks run Monday 00:00 to Sunday 23:59:59
 *    in the same zone.
 *
 * No dependency: the zone offset is read from Intl, which knows the DST rules
 * and stays right across the March and November transitions without a table
 * anyone has to maintain.
 */

export const YOLO_PERIODS = ["daily", "weekly", "monthly", "alltime"] as const;
export type YoloPeriod = (typeof YOLO_PERIODS)[number];

export function isYoloPeriod(value: unknown): value is YoloPeriod {
  return typeof value === "string" && (YOLO_PERIODS as readonly string[]).includes(value);
}

export const ARENA_TIME_ZONE = "America/New_York";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ARENA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, per Date.getUTCDay. */
  weekday: number;
}

/** What a clock on a New York wall reads at this instant. */
export function wallClockInZone(instant: Date): WallClock {
  const parts = Object.fromEntries(
    PARTS.formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // Weekday from the zoned calendar date, not from the UTC instant: at 02:00
  // UTC on a Monday it is still Sunday evening in New York.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday,
  };
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: Date): number {
  const w = wallClockInZone(instant);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - instant.getTime();
}

/**
 * The UTC instant at which a New York wall clock reads the given local time.
 *
 * Two passes: the first guess uses the offset at the naive instant, the second
 * corrects it if that guess landed on the other side of a DST change. Without
 * the second pass, the hour after each transition is off by sixty minutes.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive)));
  const correction = zoneOffsetMs(firstGuess);
  const corrected = new Date(naive - correction);
  return corrected;
}

/**
 * The upper bound for "all time". Far enough out to include everything, and
 * inside the range every layer between here and Postgres accepts.
 */
export const END_OF_TIME = new Date("9999-12-31T23:59:59.000Z");

export interface PeriodWindow {
  /** Inclusive start, or null for all time. */
  start: Date | null;
  /** Exclusive end — the first instant of the NEXT period. */
  end: Date;
  /** What the UI prints, e.g. "Sep 28, 2026" or "September 2026". */
  label: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The window a period covers, relative to `now`.
 *
 * The end is EXCLUSIVE and is the start of the next period rather than "now",
 * so a bet resolved a millisecond ago is inside today and a query run twice a
 * second apart cannot disagree about which rows belong.
 */
export function yoloPeriodBounds(period: YoloPeriod, now: Date = new Date()): PeriodWindow {
  const w = wallClockInZone(now);

  if (period === "alltime") {
    // A FAR-FUTURE SENTINEL, not JavaScript's maximum date. `new Date(8.64e15)`
    // is year 275760: valid in JS, and rejected by the Postgres driver when it
    // is bound as a parameter — which turned every All Time board into a 500.
    return { start: null, end: END_OF_TIME, label: "All Time" };
  }

  if (period === "daily") {
    const start = zonedTimeToUtc(w.year, w.month, w.day);
    const end = new Date(start.getTime() + dayLengthMs(start));
    return {
      start,
      end,
      label: `${MONTH_NAMES[w.month - 1]!.slice(0, 3)} ${w.day}, ${w.year}`,
    };
  }

  if (period === "weekly") {
    // Monday-first: Sunday (0) is the seventh day of the week just ending, not
    // the first of the one starting.
    const daysSinceMonday = (w.weekday + 6) % 7;
    const mondayMs = zonedTimeToUtc(w.year, w.month, w.day).getTime() - daysSinceMonday * 86_400_000;
    // Re-derive the calendar date so the start lands on local midnight even if
    // the subtraction crossed a DST boundary.
    const mondayWall = wallClockInZone(new Date(mondayMs + 12 * 3_600_000));
    const start = zonedTimeToUtc(mondayWall.year, mondayWall.month, mondayWall.day);
    const nextMonday = wallClockInZone(new Date(start.getTime() + 7.5 * 86_400_000));
    const end = zonedTimeToUtc(nextMonday.year, nextMonday.month, nextMonday.day);
    return {
      start,
      end,
      label: `Week of ${MONTH_NAMES[mondayWall.month - 1]!.slice(0, 3)} ${mondayWall.day}`,
    };
  }

  const start = zonedTimeToUtc(w.year, w.month, 1);
  const nextMonth = w.month === 12 ? 1 : w.month + 1;
  const nextYear = w.month === 12 ? w.year + 1 : w.year;
  const end = zonedTimeToUtc(nextYear, nextMonth, 1);
  return { start, end, label: `${MONTH_NAMES[w.month - 1]} ${w.year}` };
}

/**
 * How long the local day starting at `start` lasts. 23 or 25 hours on the two
 * DST days; hardcoding 24 would leave an hour of results in no day at all.
 */
function dayLengthMs(start: Date): number {
  const w = wallClockInZone(new Date(start.getTime() + 36 * 3_600_000));
  const nextMidnight = zonedTimeToUtc(w.year, w.month, w.day);
  return nextMidnight.getTime() - start.getTime();
}

/** Does an instant fall inside a period's window? */
export function isWithinPeriod(instant: Date, window: PeriodWindow): boolean {
  if (window.start !== null && instant < window.start) return false;
  return instant < window.end;
}
