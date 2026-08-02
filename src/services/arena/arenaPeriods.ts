/**
 * THE Arena period and scope vocabulary. Single source of truth for the worker,
 * the API and the delay rule, so none of them can drift.
 */

export const ARENA_PERIODS = ["daily", "monthly"] as const;
export type ArenaPeriod = (typeof ARENA_PERIODS)[number];

export const ARENA_SCOPES = ["wallstreetbets", "all"] as const;
export type ArenaScope = (typeof ARENA_SCOPES)[number];

/** Communities aggregated by the `all` scope. */
export const ARENA_ALL_SUBREDDITS = [
  "wallstreetbets",
  "stocks",
  "investing",
  "options",
  "pennystocks",
  "Shortsqueeze",
  "ValueInvesting",
  "SecurityAnalysis",
] as const;

export function isArenaPeriod(value: unknown): value is ArenaPeriod {
  return typeof value === "string" && (ARENA_PERIODS as readonly string[]).includes(value);
}

export function isArenaScope(value: unknown): value is ArenaScope {
  return typeof value === "string" && (ARENA_SCOPES as readonly string[]).includes(value);
}

/**
 * How far behind live the public surface is allowed to be.
 *
 * Applied twice, deliberately: market prices older than this are the only ones
 * quoted publicly, and a user-performance snapshot is only publishable once this
 * much time has passed since it was calculated. Both are the same promise — the
 * public page never reveals the present.
 */
export const PUBLIC_DELAY_MINUTES = 15;
export const PUBLIC_DELAY_MS = PUBLIC_DELAY_MINUTES * 60 * 1000;

/** The window a period covers, ending now. */
export function periodBounds(
  period: ArenaPeriod,
  now: Date = new Date(),
): { start: Date; end: Date } {
  if (period === "daily") {
    // The calendar day in UTC. Using midnight rather than a rolling 24h window
    // is what makes "daily performance" mean the same thing all day.
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    return { start, end: now };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: now };
}

/** The newest instant a public quote may carry. */
export function publicPriceCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - PUBLIC_DELAY_MS);
}
