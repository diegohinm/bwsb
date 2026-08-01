import type { DurationBucket, DurationFilter } from "./wsb.types.js";

/**
 * THE option-duration classifier. Single source of truth.
 *
 * Every surface that talks about 0DTE / Weekly / Swing / LEAPS goes through
 * here — the worker when it snapshots a position, the API when it filters one,
 * and the summary counters. If the boundaries ever move, they move once.
 *
 * Boundaries (inclusive on both ends, contiguous, no gaps):
 *
 *   0DTE    dte === 0        expires today
 *   Weekly  1 <= dte <= 7
 *   Swing   8 <= dte <= 90
 *   LEAPS   dte > 90
 *
 * An already-expired contract (dte < 0) is not a live position and is rejected
 * by `classifyDuration` rather than silently bucketed as 0DTE.
 */

export const ZERO_DTE_MAX = 0;
export const WEEKLY_MAX_DTE = 7;
export const SWING_MAX_DTE = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days from `now` to `expiration`, both truncated to UTC midnight.
 *
 * Truncating matters: an option expiring in 3 hours and one expiring in 20
 * hours are both "today" (0DTE) if they share a calendar date, and neither is
 * "1 day" just because the clock crossed a 24-hour boundary.
 */
export function daysToExpiration(expiration: Date, now: Date = new Date()): number {
  const exp = Date.UTC(
    expiration.getUTCFullYear(),
    expiration.getUTCMonth(),
    expiration.getUTCDate(),
  );
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((exp - today) / MS_PER_DAY);
}

/** Bucket for a DTE, or null when the contract has already expired. */
export function bucketForDte(dte: number): DurationBucket | null {
  if (!Number.isFinite(dte) || dte < 0) return null;
  if (dte <= ZERO_DTE_MAX) return "zero_dte";
  if (dte <= WEEKLY_MAX_DTE) return "weekly";
  if (dte <= SWING_MAX_DTE) return "swing";
  return "leaps";
}

/** Bucket for an expiration date, or null when it is in the past. */
export function classifyDuration(
  expiration: Date,
  now: Date = new Date(),
): { dte: number; bucket: DurationBucket } | null {
  const dte = daysToExpiration(expiration, now);
  const bucket = bucketForDte(dte);
  return bucket ? { dte, bucket } : null;
}

/**
 * Translate the UI's filter vocabulary into a stored bucket. `long` is the
 * table's label for LEAPS; `all` means no restriction.
 */
export function bucketForFilter(filter: DurationFilter): DurationBucket | null {
  switch (filter) {
    case "0dte":
      return "zero_dte";
    case "weekly":
      return "weekly";
    case "swing":
      return "swing";
    case "long":
      return "leaps";
    case "all":
    default:
      return null;
  }
}
