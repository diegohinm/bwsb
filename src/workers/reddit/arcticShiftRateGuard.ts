import type { RedditWorkerStore } from "./redditWorkerStore.js";

/**
 * The single throttle in front of Arctic Shift.
 *
 * Arctic Shift is a free community archive with no API key and no quota page —
 * the only thing standing between YOLOPulse and abusing it is this class. It
 * enforces three rules, in this order:
 *
 *   1. at most ONE request every `minIntervalMs` (default five minutes),
 *      measured from the START of the previous request;
 *   2. at most `maxRequestsPerHour` (12) in any rolling hour;
 *   3. never before `blockedUntil`, which a 429's Retry-After sets.
 *
 * EVERY attempt counts — successes, timeouts, 5xx, validation failures. A
 * failed request consumed upstream capacity exactly like a successful one, so
 * "retry" is not a concept here: a failure simply waits for the next slot.
 *
 * The state lives in PostgreSQL, so a restarting worker cannot forget that it
 * just made a request, and a second instance sees the same history.
 */

/** Nothing may lower these; they are the promise this worker makes. */
export const MIN_REQUEST_INTERVAL_MS = 300_000;
export const MAX_REQUESTS_PER_HOUR = 12;
const HOUR_MS = 60 * 60 * 1000;

export interface RateGuardOptions {
  workerName: string;
  store: RedditWorkerStore;
  /** Injectable clock/sleep so tests never wait five real minutes. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxRequestsPerHour?: number;
}

export interface RateGuardDecision {
  allowed: boolean;
  /** When the next request may leave. */
  nextAllowedAt: Date;
  /** Set when the hourly cap, not the interval, is what blocks. */
  reason?: "interval" | "hourly_cap" | "retry_after";
}

export class ArcticShiftRateGuard {
  private readonly workerName: string;
  private readonly store: RedditWorkerStore;
  private readonly now: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRequestsPerHour: number;

  constructor(options: RateGuardOptions) {
    this.workerName = options.workerName;
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.sleeper =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Floors, not defaults: a smaller configured value is ignored.
    this.minIntervalMs = Math.max(
      MIN_REQUEST_INTERVAL_MS,
      options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS,
    );
    this.maxRequestsPerHour = Math.min(
      MAX_REQUESTS_PER_HOUR,
      options.maxRequestsPerHour ?? MAX_REQUESTS_PER_HOUR,
    );
  }

  /** Requests made in the last hour, as of now. */
  async requestsLastHour(): Promise<number> {
    const state = await this.store.loadState(this.workerName);
    return this.prune(state.requestLog).length;
  }

  /**
   * When the next request may leave — the LATEST of the three rules.
   *
   * Reported to the operator and to `worker_runs`; the loop uses `check()`
   * so it also learns which rule is binding.
   */
  async getNextAllowedAt(): Promise<Date> {
    return (await this.check()).nextAllowedAt;
  }

  async check(): Promise<RateGuardDecision> {
    const state = await this.store.loadState(this.workerName);
    const now = this.now();
    const log = this.prune(state.requestLog);

    let nextAllowed = 0;
    let reason: RateGuardDecision["reason"];

    const lastRequest = state.lastRequestAt?.getTime();
    if (lastRequest !== undefined) {
      const afterInterval = lastRequest + this.minIntervalMs;
      if (afterInterval > nextAllowed) {
        nextAllowed = afterInterval;
        reason = "interval";
      }
    }

    // The hourly cap only binds once the window is full: the oldest request in
    // the window has to age out before another may leave.
    if (log.length >= this.maxRequestsPerHour) {
      const oldest = Date.parse(log[0] ?? "");
      if (Number.isFinite(oldest)) {
        const afterCap = oldest + HOUR_MS;
        if (afterCap > nextAllowed) {
          nextAllowed = afterCap;
          reason = "hourly_cap";
        }
      }
    }

    const blockedUntil = state.blockedUntil?.getTime();
    if (blockedUntil !== undefined && blockedUntil > nextAllowed) {
      nextAllowed = blockedUntil;
      reason = "retry_after";
    }

    return {
      allowed: now >= nextAllowed,
      nextAllowedAt: new Date(Math.max(nextAllowed, now)),
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Block until a request is permitted.
   *
   * Loops rather than sleeping once: waking up is not permission, and the
   * decision is re-read from the store in case another instance made a request
   * while this one slept.
   */
  async waitUntilAllowed(): Promise<void> {
    for (;;) {
      const decision = await this.check();
      if (decision.allowed) return;

      const waitMs = Math.max(0, decision.nextAllowedAt.getTime() - this.now());
      console.log(
        `[ArcticShiftRateGuard] Waiting ${Math.round(waitMs / 1000)}s ` +
          `reason=${decision.reason ?? "interval"} ` +
          `nextRequestAt=${decision.nextAllowedAt.toISOString()}`,
      );
      await this.sleeper(waitMs);
      if (waitMs === 0) return;
    }
  }

  /**
   * Record that a request is leaving NOW — called BEFORE the fetch.
   *
   * Before, never after: a request that hangs or throws has still been sent,
   * and a guard that only counted completed requests would let a crash loop
   * hammer the archive.
   */
  async recordRequestStarted(): Promise<Date> {
    const state = await this.store.loadState(this.workerName);
    const at = new Date(this.now());
    const log = [...this.prune(state.requestLog), at.toISOString()];
    await this.store.recordRequestStarted(this.workerName, at, log);
    return at;
  }

  /**
   * Honour a 429's `Retry-After`.
   *
   * The five-minute floor still applies: an upstream asking for 30 seconds does
   * not entitle this worker to go faster than its own promise.
   */
  async registerRetryAfter(until: Date): Promise<Date> {
    const floor = this.now() + this.minIntervalMs;
    const effective = new Date(Math.max(until.getTime(), floor));
    await this.store.setBlockedUntil(this.workerName, effective);
    console.warn(
      `[ArcticShiftRateGuard] RATE_LIMITED — blocked until ${effective.toISOString()}`,
    );
    return effective;
  }

  async clearRetryAfter(): Promise<void> {
    await this.store.setBlockedUntil(this.workerName, null);
  }

  /** Drop entries older than an hour; they no longer constrain anything. */
  private prune(log: string[]): string[] {
    const cutoff = this.now() - HOUR_MS;
    return log
      .filter((entry) => {
        const time = Date.parse(entry);
        return Number.isFinite(time) && time > cutoff;
      })
      .sort();
  }
}
