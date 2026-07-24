/**
 * Tiny in-process TTL cache.
 *
 * Third-party social APIs (Mindcase et al.) are metered and rate-limited, so
 * provider responses are cached here between requests. This is deliberately
 * simple — a single-process Map with per-key expiry. For multi-instance
 * deployments swap this for Redis or the optional `social_provider_cache`
 * table; the call sites only depend on get/set/del.
 */

type Entry = { value: unknown; expiresAt: number };

const store = new Map<string, Entry>();

/** Return a live cached value, or null when absent or expired. */
export function get<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

/** Cache `value` under `key` for `ttlSeconds`. A ttl <= 0 caches nothing. */
export function set<T>(key: string, value: T, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/** Remove a single key. */
export function del(key: string): void {
  store.delete(key);
}

/** Drop everything. Used by tests and on provider/config changes. */
export function clear(): void {
  store.clear();
}

export const memoryCache = { get, set, del, clear };
