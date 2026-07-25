/**
 * Tiny in-process TTL cache with an optional STALE window.
 *
 * Third-party social APIs (Mindcase et al.) are metered and rate-limited, so
 * provider responses are cached here between requests. This is deliberately
 * simple — a single-process Map with per-key expiry. For multi-instance
 * deployments swap this for Redis or the optional `social_provider_cache`
 * table; the call sites only depend on get/getStale/set/del.
 *
 * Two lifetimes per entry:
 *   - `expiresAt`  — until when the value is FRESH. `get` only returns fresh.
 *   - `staleUntil` — until when the value is still readable via `getStale`.
 *
 * The stale window is what lets an endpoint answer with last-known-good data
 * (clearly labeled) when the upstream is rate-limited, instead of a 500 or a
 * silent downgrade to demo data.
 */

type Entry = {
  value: unknown;
  storedAt: number;
  expiresAt: number;
  staleUntil: number;
};

const store = new Map<string, Entry>();

/**
 * How long past expiry a value stays readable as stale, as a multiple of its
 * TTL. With the default 600s TTL this keeps last-known-good data for an hour —
 * long enough to ride out a rate-limit window, short enough to not serve
 * yesterday's pulse.
 */
const DEFAULT_STALE_MULTIPLIER = 6;

/** Drop an entry once even its stale window has passed. */
function evictIfDead(key: string, entry: Entry, now: number): boolean {
  if (entry.staleUntil <= now) {
    store.delete(key);
    return true;
  }
  return false;
}

/** Return a FRESH cached value, or null when absent, expired or stale. */
export function get<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (evictIfDead(key, entry, now)) return null;
  if (entry.expiresAt <= now) return null; // expired but still stale-readable
  return entry.value as T;
}

/** A stale (expired but still readable) cache hit. */
export type StaleHit<T> = {
  value: T;
  /** Seconds since the value was stored. */
  ageSeconds: number;
};

/**
 * Return the last-known value even if it has expired, as long as it is inside
 * its stale window. Callers MUST label what they serve from here.
 */
export function getStale<T>(key: string): StaleHit<T> | null {
  const entry = store.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (evictIfDead(key, entry, now)) return null;
  return {
    value: entry.value as T,
    ageSeconds: Math.max(0, Math.round((now - entry.storedAt) / 1000)),
  };
}

/**
 * Cache `value` under `key` for `ttlSeconds`. A ttl <= 0 caches nothing.
 * `staleTtlSeconds` extends how long the value stays readable via `getStale`
 * after it expires (defaults to 6× the TTL).
 */
export function set<T>(
  key: string,
  value: T,
  ttlSeconds: number,
  staleTtlSeconds?: number,
): void {
  if (ttlSeconds <= 0) return;
  const now = Date.now();
  const staleSeconds =
    staleTtlSeconds !== undefined
      ? Math.max(0, staleTtlSeconds)
      : ttlSeconds * DEFAULT_STALE_MULTIPLIER;
  store.set(key, {
    value,
    storedAt: now,
    expiresAt: now + ttlSeconds * 1000,
    staleUntil: now + (ttlSeconds + staleSeconds) * 1000,
  });
}

/** Remove a single key. */
export function del(key: string): void {
  store.delete(key);
}

/** Drop everything. Used by tests and on provider/config changes. */
export function clear(): void {
  store.clear();
}

export const memoryCache = { get, getStale, set, del, clear };
