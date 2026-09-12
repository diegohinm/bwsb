import { env } from "../../config/env.js";

/**
 * HOW BIG THE NEXT REQUEST SHOULD BE.
 *
 * THE CONSTRAINT THIS SOLVES. Mindcase's `reddit/posts` and `reddit/comments`
 * agents accept exactly `{ urls, maxResults }` (plus an optional keyword). There
 * is no `after`, no `since`, no `cursor`, no `page` and no `offset` — the agent
 * crawls a Reddit listing and returns the newest N. The codebase already knew
 * this and said so:
 *
 *     "Mindcase has no server-side time filter, so the window is applied here."
 *
 * The consequence is the whole problem. The old ingestion kept a watermark and
 * passed `after`, which looked incremental and was not: the rows were bought
 * first and filtered afterwards. A ten-minute sync asked for 50 posts and threw
 * away the ~35 it already had, at full price.
 *
 * SO `maxResults` IS THE ONLY COST LEVER THERE IS. Not pagination — a second
 * request to the same URL returns the same rows, because there is no offset to
 * advance. Asking for fewer rows is the only thing that lowers the bill.
 *
 * THE STRATEGY: size each request from what the last one actually yielded, and
 * let the SCHEDULE absorb bursts rather than a second request. A sync that came
 * back saturated (every row new) means the window was too small, so the next one
 * asks for more; a sync that came back mostly duplicates means we are paying for
 * data we own, so the next one asks for less. Backlog is worked off across
 * consecutive syncs instead of in one expensive catch-up — which is also what
 * keeps an eight-hour outage from becoming a twenty-dollar minute.
 *
 * Pure and dependency-free, so the arithmetic can be asserted without a network
 * stub or a database.
 */

export type SyncOutcome = {
  /** How many rows the provider returned, i.e. what it billed for. */
  rowsReceived: number;
  /** How many of those were not already stored. */
  newItems: number;
  /** What this sync asked for. */
  requested: number;
};

export type SizingBounds = {
  min: number;
  max: number;
};

export function boundsForPosts(): SizingBounds {
  return { min: env.REDDIT_MIN_FETCH_LIMIT, max: env.REDDIT_POSTS_FETCH_LIMIT };
}

export function boundsForComments(): SizingBounds {
  return { min: env.REDDIT_MIN_FETCH_LIMIT, max: env.REDDIT_COMMENTS_FETCH_LIMIT };
}

/**
 * Headroom over the last sync's yield.
 *
 * Asking for exactly what arrived last time guarantees saturation on any
 * uptick, and a saturated sync cannot tell "caught everything" from "there was
 * more". Half again leaves room to observe the boundary, which is what makes
 * the next decision informed rather than a guess.
 */
const HEADROOM = 1.5;

/** Rows to add for the overlap window, which is re-requested on purpose. */
function overlapAllowance(): number {
  return env.REDDIT_SYNC_OVERLAP_SECONDS > 0 ? 2 : 0;
}

/**
 * Was the last response big enough to prove we saw everything?
 *
 * A response where EVERY row was new is the ambiguous case: the provider handed
 * back a full page of unseen items, so there may well be more just past the
 * edge. That is the one situation that justifies spending more next time.
 */
export function isSaturated(outcome: SyncOutcome): boolean {
  return outcome.rowsReceived > 0 && outcome.newItems >= outcome.rowsReceived;
}

/**
 * The size of the next request for this stream.
 *
 * Grows only on saturation and shrinks whenever there is slack, so the steady
 * state on a quiet stream is the floor rather than the ceiling — which is the
 * opposite of the old fixed 50 and is where the saving comes from.
 */
export function nextRequestSize(
  outcome: SyncOutcome | null,
  bounds: SizingBounds,
): number {
  const floor = Math.min(bounds.min, bounds.max);
  // No history: start at the floor, not the ceiling. A cold start that guesses
  // high pays for a full page before learning anything, and the very next sync
  // would have corrected it anyway.
  if (!outcome || outcome.rowsReceived === 0) return floor;

  if (isSaturated(outcome)) {
    // Doubling rather than +1: a burst that outruns the window needs to be
    // caught in a sync or two, not twenty. The max clamp is the real protection.
    return clamp(Math.max(outcome.requested * 2, outcome.newItems + 2), floor, bounds.max);
  }

  const target = Math.ceil(outcome.newItems * HEADROOM) + overlapAllowance();
  return clamp(target, floor, bounds.max);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.max(1, Math.trunc(value))));
}

/**
 * How much less often a lower-priority thread is polled.
 *
 * THE ONE-MINUTE CADENCE IS FOR THE MEGATHREAD, NOT FOR EVERY THREAD. Applying
 * it to all of them multiplies the bill by the number of threads in the
 * rotation, for conversations that produce a comment every few minutes at best —
 * so a poll of a P2 thread buys almost nothing and costs the same per row as a
 * poll of the live Daily Discussion.
 *
 *   P0  the live Daily / Tomorrow / Weekend megathread   every tick
 *   P1  a recent post with real comment activity         every 5th
 *   P2  everything else recent                           every 10th
 *
 * At the configured one-minute market-open cadence that reads as 1m / 5m / 10m,
 * which is what the cost model assumes.
 */
const PRIORITY_INTERVAL_MULTIPLIER: Record<number, number> = { 0: 1, 1: 5, 2: 10 };

export function intervalForPriority(baseIntervalMs: number, priority: number): number {
  return baseIntervalMs * (PRIORITY_INTERVAL_MULTIPLIER[priority] ?? 10);
}

/**
 * WHEN THIS STREAM SHOULD BE SYNCED AGAIN.
 *
 * The cadence the operator configured is a CEILING on frequency, not a promise
 * that every stream is polled at it. A thread that has returned nothing for
 * several runs is billed for on every poll and yields nothing, so it backs off
 * geometrically and is eventually retired — that is what stops the comment
 * sweep growing without bound as threads accumulate.
 *
 * An active stream always uses the base interval, so a live megathread during
 * market hours really is checked every minute.
 */
export function nextSyncDelayMs(
  baseIntervalMs: number,
  consecutiveEmptyRuns: number,
): number {
  if (consecutiveEmptyRuns <= 0) return baseIntervalMs;
  // 2×, 4×, 8× … capped at eight, so even a dormant stream is re-checked
  // occasionally rather than abandoned by arithmetic.
  const factor = Math.min(2 ** consecutiveEmptyRuns, 8);
  return baseIntervalMs * factor;
}

/** Whether a stream has gone quiet for long enough to leave the rotation. */
export function shouldRetire(consecutiveEmptyRuns: number, isProtected: boolean): boolean {
  // The live megathreads are never retired: they are the product's centre of
  // gravity and a quiet hour overnight must not remove them from the rotation.
  if (isProtected) return false;
  return consecutiveEmptyRuns >= env.REDDIT_THREAD_IDLE_RUNS;
}

/**
 * WHY THERE IS NO TIMESTAMP CUTOFF HERE.
 *
 * The obvious design is a high-water mark: remember the newest item stored and
 * ignore anything at or before it. That is what the old ingestion did, and it
 * is subtly wrong in two ways at once.
 *
 * First, it cannot be sent upstream — the agent has no time filter, so the
 * cutoff could only ever be applied AFTER the rows were bought. Second, applied
 * locally it is strictly worse than what we already have: provider timestamps
 * are coarse and arrival order is not guaranteed, so a `> lastSeen` comparison
 * silently drops items sharing a second with the checkpoint. That is the bug
 * the "overlap window" exists to paper over.
 *
 * Deduplication here is by REDDIT ID, against the unique `external_id` column
 * (see redditSync.partitionNew). An id either is or is not already stored;
 * there is no clock skew, no ordering assumption and nothing to miss. So the
 * overlap has no window to widen — it survives only as `overlapAllowance()`
 * above, a couple of extra rows of slack in the request size, which is the one
 * thing it can still usefully buy.
 *
 * REDDIT_SYNC_OVERLAP_SECONDS therefore tunes request headroom rather than a
 * time boundary. A `overlapCutoff()` helper existed here briefly and was
 * removed rather than left unused: a function that computes a cutoff nothing
 * applies is an invitation to start applying it.
 */
