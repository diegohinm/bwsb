import { extendedHoursEnabled } from "../../config/env.js";
import type { MarketSession } from "./marketData.types.js";

/**
 * Shared market-data helpers: US market session detection and a deterministic
 * pseudo-random generator so the mock provider is stable across calls.
 */

/** Deterministic 32-bit FNV-1a hash. */
export function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const rand = (seed: string) => hash(seed) / 0xffffffff;
export const randInt = (seed: string, min: number, max: number) =>
  min + Math.floor(rand(seed) * (max - min + 1));

export const round2 = (v: number) => Math.round(v * 100) / 100;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** US regular trading hours, in minutes past midnight ET. */
const REGULAR_OPEN = 9 * 60 + 30; // 09:30
const REGULAR_CLOSE = 16 * 60; // 16:00
const PREMARKET_OPEN = 4 * 60; // 04:00
const AFTER_HOURS_END = 20 * 60; // 20:00

/** Wall-clock position in America/New_York, without pulling in a tz library. */
function easternClock(now: Date): { day: number; minutes: number } {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return {
    day: et.getDay(), // 0 = Sun, 6 = Sat
    minutes: et.getHours() * 60 + et.getMinutes(),
  };
}

/**
 * True when the instant falls inside the US REGULAR session:
 * 09:30–16:00 America/New_York on a weekday.
 *
 * Weekday-only and holiday-unaware, exactly as before — a market holiday simply
 * produces no bars, and the "no data" path already handles that.
 */
export function isRegularSession(now: Date = new Date()): boolean {
  const { day, minutes } = easternClock(now);
  if (day === 0 || day === 6) return false;
  return minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE;
}

/**
 * The full five-session breakdown. PRESERVED but only reachable when
 * ENABLE_EXTENDED_HOURS is on — `currentSession` is the gate.
 *
 *   premarket    04:00–09:30 ET (weekday)
 *   regular      09:30–16:00 ET (weekday)
 *   after_hours  16:00–20:00 ET (weekday)
 *   overnight    20:00–04:00 ET (weekday nights)
 *   closed       weekends
 */
export function extendedSession(now: Date = new Date()): MarketSession {
  const { day, minutes } = easternClock(now);
  if (day === 0 || day === 6) return "closed";

  if (minutes >= PREMARKET_OPEN && minutes < REGULAR_OPEN) return "premarket";
  if (minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE) return "regular";
  if (minutes >= REGULAR_CLOSE && minutes < AFTER_HOURS_END) return "after_hours";
  return "overnight";
}

/**
 * The session an instant belongs to, as the product is configured.
 *
 * With ENABLE_EXTENDED_HOURS off this collapses to the only two states the
 * product recognises — "regular" inside 09:30–16:00 ET, "closed" otherwise —
 * so no premarket/after-hours/overnight value can reach a response, a snapshot
 * row or a cache key.
 */
export function currentSession(now: Date = new Date()): MarketSession {
  if (!extendedHoursEnabled) return isRegularSession(now) ? "regular" : "closed";
  return extendedSession(now);
}
