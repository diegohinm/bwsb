/**
 * THE Calendar vocabulary. Single source of truth shared by the provider layer,
 * the worker job, the read service and the routes, so none of them can drift
 * apart on what "confirmed" or "after_market" means.
 */

/** Views the frontend can request. Also the allowed `default_view` values. */
export const CALENDAR_VIEWS = ["month", "week", "list"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/**
 * When in the trading day the report lands.
 *
 * `unknown` is a real, common answer — most providers publish a date long
 * before the company says whether it reports before the open or after the
 * close. It must never be silently promoted to one of the other three.
 */
export const EARNINGS_TIMINGS = [
  "before_market",
  "after_market",
  "during_market",
  "unknown",
] as const;
export type EarningsTiming = (typeof EARNINGS_TIMINGS)[number];

/**
 * How much the date can be trusted.
 *
 * `confirmed` means the company scheduled it or the provider marked it
 * confirmed. `estimated` means it was projected — typically from last year's
 * reporting pattern. The default everywhere is `estimated`: an unlabelled date
 * is an unconfirmed date.
 */
export const EARNINGS_STATUSES = ["confirmed", "estimated"] as const;
export type EarningsStatus = (typeof EARNINGS_STATUSES)[number];

/** Social windows the public calendar can rank trending tickers over. */
export const SOCIAL_TIMEFRAMES = ["24h", "7d", "30d"] as const;
export type SocialTimeframe = (typeof SOCIAL_TIMEFRAMES)[number];

export const SOCIAL_TIMEFRAME_MS: Record<SocialTimeframe, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Earnings are a US-market event, so dates and BMO/AMC are anchored to the
 * exchange's timezone rather than the viewer's. The frontend may additionally
 * show a local time, but the market timing is what is stored and returned.
 */
export const MARKET_TIMEZONE = "America/New_York";

/** Public market prices on the Calendar carry the same delay as everywhere else. */
export const PUBLIC_DELAY_MINUTES = 15;
export const PUBLIC_DELAY_MS = PUBLIC_DELAY_MINUTES * 60 * 1000;

/** How many top-mentioned tickers the public calendar draws from, by default. */
export const DEFAULT_TRENDING_LIMIT = 30;
export const MAX_TRENDING_LIMIT = 60;

/** Ceiling on a signed-in user's hand-picked symbols. */
export const MAX_PERSONAL_TICKERS = 50;

/** How many days a single request may span, so one URL cannot scan the table. */
export const MAX_RANGE_DAYS = 120;

export function isCalendarView(value: unknown): value is CalendarView {
  return typeof value === "string" && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

export function isEarningsTiming(value: unknown): value is EarningsTiming {
  return typeof value === "string" && (EARNINGS_TIMINGS as readonly string[]).includes(value);
}

export function isEarningsStatus(value: unknown): value is EarningsStatus {
  return typeof value === "string" && (EARNINGS_STATUSES as readonly string[]).includes(value);
}

export function isSocialTimeframe(value: unknown): value is SocialTimeframe {
  return typeof value === "string" && (SOCIAL_TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Coerce a provider's free-form timing string to the vocabulary.
 *
 * Anything unrecognized becomes `unknown` rather than a guess — a provider
 * writing "TAS" or "--" must not be rounded to "before_market".
 */
export function normalizeTiming(raw: unknown): EarningsTiming {
  if (isEarningsTiming(raw)) return raw;
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase();
  if (["bmo", "before", "before market open", "pre", "premarket", "pre-market"].includes(v)) {
    return "before_market";
  }
  if (["amc", "after", "after market close", "post", "postmarket", "post-market"].includes(v)) {
    return "after_market";
  }
  if (["dmh", "during", "during market hours", "intraday"].includes(v)) return "during_market";
  return "unknown";
}

/** Coerce a provider's confirmation flag. Unknown values stay `estimated`. */
export function normalizeStatus(raw: unknown): EarningsStatus {
  if (isEarningsStatus(raw)) return raw;
  if (typeof raw !== "string") return "estimated";
  const v = raw.trim().toLowerCase();
  if (["confirmed", "verified", "scheduled", "official"].includes(v)) return "confirmed";
  return "estimated";
}

/** `YYYY-MM-DD` for a Date, in UTC — report dates are stored as bare dates. */
export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse `YYYY-MM-DD` into a UTC midnight Date, or null when malformed. */
export function parseDateKey(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  // Rejects 2026-02-31 and friends, which Date silently rolls forward.
  if (toDateKey(date) !== raw.trim()) return null;
  return date;
}

/** The public delay cutoff: the newest instant a public quote may carry. */
export function publicPriceCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - PUBLIC_DELAY_MS);
}

/**
 * The default range when the caller gives none: the current calendar month
 * padded by a week on each side, so a month grid's leading and trailing days
 * are populated too.
 */
export function defaultRange(now: Date = new Date()): { start: Date; end: Date } {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    start: new Date(first.getTime() - 7 * 24 * 60 * 60 * 1000),
    end: new Date(last.getTime() + 7 * 24 * 60 * 60 * 1000),
  };
}
