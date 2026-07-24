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

/**
 * Current US market session from the wall clock, using US/Eastern.
 *   premarket    04:00–09:30 ET (weekday)
 *   regular      09:30–16:00 ET (weekday)
 *   after_hours  16:00–20:00 ET (weekday)
 *   overnight    20:00–04:00 ET (weekday nights)
 *   closed       weekends
 */
export function currentSession(now: Date = new Date()): MarketSession {
  // Convert to ET without pulling in a tz library.
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0 = Sun, 6 = Sat
  const minutes = et.getHours() * 60 + et.getMinutes();

  const isWeekend = day === 0 || day === 6;
  if (isWeekend) return "closed";

  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;
  const PRE = 4 * 60;
  const AH_END = 20 * 60;

  if (minutes >= PRE && minutes < OPEN) return "premarket";
  if (minutes >= OPEN && minutes < CLOSE) return "regular";
  if (minutes >= CLOSE && minutes < AH_END) return "after_hours";
  return "overnight";
}
