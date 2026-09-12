/**
 * THE US MARKET CALENDAR — one implementation, used by everything that needs to
 * know whether the market is open.
 *
 * WHY THIS EXISTS RATHER THAN REUSING WHAT WAS HERE. `marketData.util
 * .isRegularSession` answered the question with "is it a weekday between 09:30
 * and 16:00 ET", and said so in its own comment: *holiday-unaware*. For quote
 * ingestion that was harmless — a market holiday produces no bars and the
 * no-data path already handled it. For deciding how often to PAY Mindcase it is
 * not harmless at all: it would run the expensive one-minute comment cadence
 * through Thanksgiving, Good Friday, Christmas and every early close, buying
 * rows from a market that is shut. That is roughly ten wasted full-rate days a
 * year plus a dozen half-days.
 *
 * `isRegularSession` now delegates here, so there is still exactly ONE answer in
 * the codebase — this file replaced the weaker implementation instead of
 * sitting beside it.
 *
 * RULES, NOT A HARDCODED LIST. A table of dates is correct until the year it
 * was written for ends, and then fails silently: every holiday becomes a
 * trading day and nobody notices except the invoice. The NYSE holiday schedule
 * is defined by rules ("third Monday in January", "Friday before Easter"), so
 * the rules are what is encoded.
 *
 * NO PROVIDER CALL. Asking Databento whether the market is open, once a minute,
 * would make the cost-control mechanism itself a recurring cost — and would tie
 * Reddit ingestion to a market provider, which is precisely the coupling the
 * architecture forbids.
 */

export type UsMarketSessionStatus = {
  /** A weekday the exchange is open at all. False on weekends and holidays. */
  isMarketDay: boolean;
  /** Inside 09:30 ET → close on a market day. The one the scheduler reads. */
  isRegularSessionOpen: boolean;
  /** ISO instant of this day's 09:30 ET open. Null when not a market day. */
  sessionOpen: string | null;
  /** ISO instant of this day's close — 16:00 ET, or 13:00 on an early close. */
  sessionClose: string | null;
  /** True on the half-days around Independence Day, Thanksgiving and Christmas. */
  isEarlyClose: boolean;
  /** Named when the day is a holiday, for logs that have to explain themselves. */
  holiday: string | null;
  /** Always "America/New_York". Present so a log line can prove it. */
  timezone: "America/New_York";
};

export const MARKET_TIMEZONE = "America/New_York" as const;

const REGULAR_OPEN_MINUTES = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTES = 16 * 60;
const EARLY_CLOSE_MINUTES = 13 * 60;

/**
 * The wall clock in New York, read through Intl rather than reconstructed.
 *
 * The previous approach — `new Date(d.toLocaleString("en-US", { timeZone }))` —
 * formats a date to a string and parses it back, which depends on the engine
 * producing a format the Date parser happens to accept. `formatToParts` asks
 * for the fields directly, so the conversion has no string round-trip to get
 * wrong, and DST is handled by the timezone database rather than by arithmetic.
 */
function easternParts(at: Date): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: Math.max(0, weekdays.indexOf(get("weekday"))),
    // "24" is how hour12:false reports midnight in some ICU versions.
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/** A calendar date with no time and no zone — how holiday rules are expressed. */
type CivilDate = { year: number; month: number; day: number };

const dateKey = (d: CivilDate) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** Day of week for a civil date, via UTC so no local zone can shift it. */
function weekdayOf(d: CivilDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** The `n`th `weekday` of a month — "third Monday in January". */
function nthWeekday(year: number, month: number, weekday: number, n: number): CivilDate {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  return { year, month, day: 1 + offset + (n - 1) * 7 };
}

/** The last `weekday` of a month — "last Monday in May". */
function lastWeekday(year: number, month: number, weekday: number): CivilDate {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  const back = (lastDow - weekday + 7) % 7;
  return { year, month, day: lastDay - back };
}

/**
 * Easter Sunday, by the anonymous Gregorian algorithm.
 *
 * Needed because Good Friday is the one NYSE holiday with no fixed date and no
 * weekday rule — it is the Friday before Easter, and Easter moves by up to a
 * month. Hardcoding it is exactly the trap this file avoids.
 */
function easterSunday(year: number): CivilDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function addDays(d: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Move a fixed-date holiday to the day the exchange actually closes.
 *
 * Saturday → the Friday before; Sunday → the Monday after.
 *
 * NEW YEAR'S DAY IS THE EXCEPTION and it is a real one: when January 1 falls on
 * a Saturday the NYSE does NOT close on December 31, because that Friday
 * belongs to the previous year's trading calendar. Applying the general rule
 * there would mark a normal trading day as a holiday and silently drop a day of
 * ingestion cadence every few years.
 */
function observed(d: CivilDate, isNewYearsDay = false): CivilDate | null {
  const dow = weekdayOf(d);
  if (dow === 6) return isNewYearsDay ? null : addDays(d, -1);
  if (dow === 0) return addDays(d, 1);
  return d;
}

/** Every NYSE full-day closure in a calendar year, keyed by date. */
function holidaysFor(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const add = (date: CivilDate | null, name: string) => {
    if (date && date.year === year) out.set(dateKey(date), name);
  };

  add(observed({ year, month: 1, day: 1 }, true), "New Year's Day");
  add(nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day");
  add(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  add(addDays(easterSunday(year), -2), "Good Friday");
  add(lastWeekday(year, 5, 1), "Memorial Day");
  // Observed as a market holiday since 2022; before that it was a trading day.
  if (year >= 2022) add(observed({ year, month: 6, day: 19 }), "Juneteenth");
  add(observed({ year, month: 7, day: 4 }), "Independence Day");
  add(nthWeekday(year, 9, 1, 1), "Labor Day");
  add(nthWeekday(year, 11, 4, 4), "Thanksgiving Day");
  add(observed({ year, month: 12, day: 25 }), "Christmas Day");

  // January 1 of the FOLLOWING year can be observed on December 31 of this one.
  const nextNewYear = observed({ year: year + 1, month: 1, day: 1 }, true);
  if (nextNewYear && nextNewYear.year === year) {
    out.set(dateKey(nextNewYear), "New Year's Day (observed)");
  }

  return out;
}

/**
 * The 1:00 PM ET half-days.
 *
 * All three hang off a full holiday: the day before Independence Day, the
 * Friday after Thanksgiving, and Christmas Eve. Each only counts when it is
 * itself a trading day — Christmas Eve on a Sunday is not an early close, it is
 * a weekend.
 */
function earlyClosesFor(year: number): Set<string> {
  const out = new Set<string>();
  const addIfWeekday = (d: CivilDate) => {
    const dow = weekdayOf(d);
    if (dow !== 0 && dow !== 6) out.add(dateKey(d));
  };

  const july4 = observed({ year, month: 7, day: 4 });
  if (july4) addIfWeekday(addDays(july4, -1));

  addIfWeekday(addDays(nthWeekday(year, 11, 4, 4), 1));
  addIfWeekday({ year, month: 12, day: 24 });

  return out;
}

/** Per-year rule evaluation, memoized — the rules cannot change within a year. */
const yearCache = new Map<number, { holidays: Map<string, string>; earlyCloses: Set<string> }>();

function calendarFor(year: number) {
  let entry = yearCache.get(year);
  if (!entry) {
    entry = { holidays: holidaysFor(year), earlyCloses: earlyClosesFor(year) };
    yearCache.set(year, entry);
  }
  return entry;
}

/**
 * Convert a New York wall-clock time on a given civil date into a real instant.
 *
 * Done by search rather than by adding a fixed offset, because the offset is
 * exactly what is unknown: -05:00 or -04:00 depending on DST, and on the two
 * transition days the answer changes partway through the day. Two candidate
 * offsets are tried and the one that reads back as the intended wall-clock time
 * is the correct instant. On the spring-forward day 09:30 exists under only one
 * of them, which is the right answer for the same reason.
 */
function easternWallClockToInstant(date: CivilDate, minutes: number): string | null {
  for (const offsetHours of [4, 5]) {
    const guess = new Date(
      Date.UTC(date.year, date.month - 1, date.day, Math.floor(minutes / 60) + offsetHours, minutes % 60),
    );
    const parts = easternParts(guess);
    if (
      parts.year === date.year &&
      parts.month === date.month &&
      parts.day === date.day &&
      parts.minutes === minutes
    ) {
      return guess.toISOString();
    }
  }
  return null;
}

/**
 * THE ONE FUNCTION. Everything that needs to know the market's state calls this.
 */
export function getUsMarketSessionStatus(now: Date = new Date()): UsMarketSessionStatus {
  const et = easternParts(now);
  const today: CivilDate = { year: et.year, month: et.month, day: et.day };
  const key = dateKey(today);
  const { holidays, earlyCloses } = calendarFor(et.year);

  const isWeekend = et.weekday === 0 || et.weekday === 6;
  const holiday = holidays.get(key) ?? null;
  const isMarketDay = !isWeekend && holiday === null;
  const isEarlyClose = isMarketDay && earlyCloses.has(key);
  const closeMinutes = isEarlyClose ? EARLY_CLOSE_MINUTES : REGULAR_CLOSE_MINUTES;

  return {
    isMarketDay,
    isRegularSessionOpen:
      isMarketDay && et.minutes >= REGULAR_OPEN_MINUTES && et.minutes < closeMinutes,
    sessionOpen: isMarketDay ? easternWallClockToInstant(today, REGULAR_OPEN_MINUTES) : null,
    sessionClose: isMarketDay ? easternWallClockToInstant(today, closeMinutes) : null,
    isEarlyClose,
    holiday,
    timezone: MARKET_TIMEZONE,
  };
}

/** Convenience wrapper — the single boolean most callers actually want. */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  return getUsMarketSessionStatus(now).isRegularSessionOpen;
}
