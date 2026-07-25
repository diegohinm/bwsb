import { env } from "../../config/env.js";
import { memoryCache } from "../cache/memoryCache.js";
import { getSocialDataProvider, mockSocialDataProvider } from "./socialDataProvider.factory.js";
import { PULSE_TIMEFRAMES } from "./socialData.types.js";
import type {
  PulseTimeframe,
  SocialContentType,
  SocialFeedSort,
  SocialProviderStatus,
  SocialSentiment,
  SubredditPulseResponse,
  TickerSocialFeedResponse,
} from "./socialData.types.js";

/**
 * Social data access point. Routes call THIS module — never a provider
 * directly — so caching, mock fallback and status reporting are applied
 * uniformly and the upstream can be swapped via SOCIAL_DATA_PROVIDER alone.
 *
 *   off  → provider disabled; demo data is served with a warning
 *   mock → local demo fixtures
 *   else → that provider when configured, otherwise graceful mock fallback
 *
 * Resilience (QA-203): providers like Mindcase run async jobs (start + poll)
 * that can take tens of seconds. To keep the PUBLIC endpoints snappy during a
 * provider outage this module:
 *   1. bounds the INTERACTIVE wait to a short deadline (< 2s) → labeled demo;
 *   2. trips a CIRCUIT BREAKER after repeated failures so subsequent requests
 *      serve demo data instantly (no per-request wait) during the outage;
 *   3. keeps trying the provider in the BACKGROUND (single-flight per key) so
 *      real data is warmed into the cache the moment the provider recovers.
 *
 * Rate-limit protection (Mindcase 429s):
 *   4. SINGLE-FLIGHT per cache key for interactive reads too — two concurrent
 *      requests for the same pulse (React StrictMode double-render, Pulse page
 *      + dashboard strip) share ONE upstream call, never two Mindcase jobs;
 *   5. STALE-WHILE-ERROR — when the provider fails or is rate-limited and a
 *      previous REAL payload is still inside its stale window, that payload is
 *      served (isMock stays false, source stays the provider) with an explicit
 *      warning. Demo data is only used when there is nothing cached at all.
 */

const TTL = env.SOCIAL_CACHE_TTL_SECONDS;

/**
 * How long a MOCK/demo fallback payload is cached. Deliberately short so the
 * provider is retried soon after it recovers instead of being masked by a stale
 * 10-minute demo entry. Real payloads are cached for the full TTL.
 */
const FALLBACK_TTL_SECONDS = Math.min(20, TTL);

/**
 * Upper bound on how long an INTERACTIVE request waits for the upstream before
 * serving labeled demo data. Kept under ~2s so Pulse and its filters never sit
 * on a multi-second loader while a slow provider is polled.
 */
const PROVIDER_INTERACTIVE_DEADLINE_MS = 1_500;

/**
 * A BACKGROUND revalidation may wait much longer — nobody is blocked on it, and
 * a slow-but-alive provider still warms real data into the cache for next time.
 * Generous on purpose: a rate-limit-safe Mindcase sweep (2 subreddits at a time,
 * 3s between job polls) legitimately takes minutes, and abandoning it early
 * would both waste the upstream calls already spent and keep the breaker open.
 */
const PROVIDER_BACKGROUND_DEADLINE_MS = 180_000;

/** Consecutive failures before the breaker opens. */
const BREAKER_FAILURE_THRESHOLD = 2;
/** How long the breaker stays open (serving instant demo) before a half-open retry. */
const BREAKER_COOLDOWN_MS = 60_000;

/** Raised when a provider call exceeds its deadline. */
class ProviderTimeoutError extends Error {
  constructor(provider: string, ms: number) {
    super(`${provider} provider timed out after ${ms}ms.`);
    this.name = "ProviderTimeoutError";
  }
}

/** Race a provider call against a deadline. */
function withDeadline<T>(provider: string, work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderTimeoutError(provider, ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
const breaker = { failures: 0, openUntil: 0 };

function nowMs(): number {
  return Date.now();
}
function breakerOpen(): boolean {
  return nowMs() < breaker.openUntil;
}
function recordProviderFailure(): void {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_FAILURE_THRESHOLD) {
    breaker.openUntil = nowMs() + BREAKER_COOLDOWN_MS;
  }
}
function recordProviderOk(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
  lastFallbackReason = null;
}

/** Minimal shape every social payload shares. */
interface SocialPayload {
  isMock: boolean;
  warning?: string;
}

// ── Single-flight: one upstream call per cache key ───────────────────────────
/**
 * In-flight upstream calls keyed by cache key. Any number of concurrent readers
 * — two browser tabs, React's double-invoked effects, the Pulse page and the
 * dashboard ticker strip asking for the same timeframe — attach to the SAME
 * promise, so the provider is called once. The entry is removed when it settles,
 * so a later request still gets fresh data.
 */
const inFlightRequests = new Map<string, Promise<SocialPayload>>();

/** Join the in-flight call for `key`, or start one. */
function singleFlight<T extends SocialPayload>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing as Promise<T>;

  const promise = work().finally(() => {
    inFlightRequests.delete(key);
  });
  inFlightRequests.set(key, promise as Promise<SocialPayload>);
  // A shared promise may outlive the consumer that started it (deadline hit,
  // client gone). Keep a no-op handler so a late rejection is never "unhandled".
  promise.catch(() => {});
  return promise;
}

// ── Background revalidation ─────────────────────────────────────────────────
/** Cache keys that already have a background watcher attached. */
const backgroundWatch = new Set<string>();

/**
 * Warm real data into the cache in the background without blocking anyone. Only
 * one watcher runs per cache key; a duplicate `work` promise is swallowed so it
 * never becomes an unhandled rejection.
 */
function revalidateInBackground<T extends SocialPayload>(
  key: string,
  providerName: string,
  work: Promise<T>,
): void {
  if (backgroundWatch.has(key)) {
    work.catch(() => {});
    return;
  }
  backgroundWatch.add(key);
  void withDeadline(providerName, work, PROVIDER_BACKGROUND_DEADLINE_MS)
    .then((fresh) => {
      if (!fresh.isMock) {
        memoryCache.set(key, fresh, TTL);
        recordProviderOk();
        recordSuccess(false);
      }
    })
    .catch((err) => {
      recordProviderFailure();
      recordError(err);
      // The interactive path usually gives up on its short deadline before the
      // upstream answers, so THIS is where a 429 is actually observed. Remember
      // it so the warning users see names the real cause.
      if (!(err instanceof ProviderTimeoutError)) {
        lastFallbackReason = isRateLimitFailure(err) ? "rate_limit" : "failure";
      }
    })
    .finally(() => {
      backgroundWatch.delete(key);
    });
}

/** Diagnostics surfaced by /api/ingestion/status and any admin page. */
type Diagnostics = {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  usingMockFallback: boolean;
  breakerOpen: boolean;
  breakerOpenUntil: string | null;
};

const diagnostics: Diagnostics = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  usingMockFallback: false,
  breakerOpen: false,
  breakerOpenUntil: null,
};

function isDisabled(): boolean {
  return (env.SOCIAL_DATA_PROVIDER as string) === "off";
}

/** Never logs secrets — provider code already sanitizes its own messages. */
function recordError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  diagnostics.lastErrorAt = new Date().toISOString();
  diagnostics.lastError = msg;
  return msg;
}

function recordSuccess(usingMock: boolean): void {
  diagnostics.lastSuccessAt = new Date().toISOString();
  diagnostics.usingMockFallback = usingMock;
}

/**
 * Provider status for /api/ingestion/status. Reflects the CONFIGURED provider's
 * own health (ready / mock / misconfigured), independent of per-request errors.
 */
export async function getSocialProviderStatus(): Promise<SocialProviderStatus> {
  if (isDisabled()) {
    return {
      provider: "mock",
      status: "mock",
      source: "mock",
      networkAccess: false,
      message: "SOCIAL_DATA_PROVIDER=off — social feed disabled, serving demo data.",
      updatedAt: new Date().toISOString(),
    };
  }
  const provider = getSocialDataProvider();
  try {
    return await provider.getStatus();
  } catch (err) {
    return {
      provider: provider.name,
      status: "error",
      source: provider.name,
      networkAccess: false,
      message: recordError(err),
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Full diagnostics blob for /api/ingestion/status and admin. No secrets. */
export async function getIngestionStatus() {
  const status = await getSocialProviderStatus();
  return {
    social: {
      ...status,
      configuredProvider: env.SOCIAL_DATA_PROVIDER,
      cacheTtlSeconds: TTL,
      // Rate-limit guards actually in force. Values only — no secrets.
      limits: {
        maxConcurrency: env.MINDCASE_MAX_CONCURRENCY,
        pollIntervalMs: env.MINDCASE_POLL_INTERVAL_MS,
        maxPolls: env.MINDCASE_MAX_POLLS,
        maxRetries: env.MINDCASE_MAX_RETRIES,
      },
      inFlightRequests: inFlightRequests.size,
      lastSuccessAt: diagnostics.lastSuccessAt,
      lastErrorAt: diagnostics.lastErrorAt,
      lastError: diagnostics.lastError,
      usingMockFallback: diagnostics.usingMockFallback,
      breakerOpen: breakerOpen(),
      breakerOpenUntil: breaker.openUntil ? new Date(breaker.openUntil).toISOString() : null,
    },
  };
}

const DISABLED_WARNING =
  "Social data provider is disabled (SOCIAL_DATA_PROVIDER=off). Showing demo data.";

/** Human-facing provider name used in warnings shown in the UI. */
function providerLabel(provider: string): string {
  switch (provider) {
    case "mindcase":
      return "Mindcase";
    case "brandwatch":
      return "Brandwatch";
    case "reddit_official":
      return "Reddit Official API";
    default:
      return provider;
  }
}

/** Why a fallback path was taken. Drives the warning text shown in the UI. */
type FallbackReason =
  | "rate_limit"
  | "timeout"
  | "misconfigured"
  | "failure"
  | "breaker";

/**
 * Why the provider last failed. Once the breaker opens, requests no longer touch
 * the provider and would otherwise lose the reason — but the user still needs to
 * know WHY they are looking at cached data. Reset on the next success.
 */
let lastFallbackReason: FallbackReason | null = null;

/** Warning for last-known-good REAL data served from the stale cache. */
function staleWarning(provider: string, reason: FallbackReason): string {
  const label = providerLabel(provider);
  switch (reason) {
    case "rate_limit":
      return `${label} rate limit reached. Showing cached data.`;
    case "timeout":
      return `${label} is taking too long. Showing cached data — retrying live data in the background.`;
    case "breaker":
      return `${label} is temporarily unavailable. Showing cached data — retrying live data in the background.`;
    case "misconfigured":
      return `${label} is not configured. Showing cached data.`;
    case "failure":
    default:
      return `${label} is unavailable. Showing cached data.`;
  }
}

/** Warning for demo data served because nothing real was cached. */
function mockWarning(provider: string, reason: FallbackReason): string {
  const label = providerLabel(provider);
  switch (reason) {
    case "rate_limit":
      return `${label} unavailable. Showing demo data.`;
    case "timeout":
      return `${label} is taking too long. Showing demo data — retrying live data in the background.`;
    case "breaker":
      return `${label} is temporarily unavailable. Showing demo data — retrying live data in the background.`;
    case "misconfigured":
      return `${label} provider is not configured. Showing demo data.`;
    case "failure":
    default:
      return `${label} unavailable. Showing demo data.`;
  }
}

/** True when a failure means the upstream told us to slow down (HTTP 429). */
function isRateLimitFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "MindcaseRateLimitError") return true;
  if ((err as { status?: number }).status === 429) return true;
  return /rate limit|429/i.test(err.message);
}

/**
 * Demo payloads live under their own key so they can never evict the last real
 * payload — stale real data must stay available to fall back on.
 */
function fallbackKey(key: string): string {
  return `${key}::fallback`;
}

/**
 * Serve the best honest answer when the provider could not be reached:
 *   1. last-known-good REAL data from the stale cache (isMock stays false,
 *      source stays the provider) + a warning saying it is cached;
 *   2. otherwise labeled demo data (isMock true) + a warning saying so.
 */
async function staleOrMock<T extends SocialPayload>(
  key: string,
  provider: string,
  fetchMock: () => Promise<T>,
  reason: FallbackReason,
): Promise<T> {
  const stale = memoryCache.getStale<T>(key);
  if (stale && !stale.value.isMock) {
    recordSuccess(false);
    // Copy: never mutate the cached object with a request-specific warning.
    return { ...stale.value, warning: staleWarning(provider, reason) };
  }

  const cachedMock = memoryCache.get<T>(fallbackKey(key));
  if (cachedMock) return { ...cachedMock, warning: mockWarning(provider, reason) };

  const result = await fetchMock();
  result.warning = mockWarning(provider, reason);
  recordSuccess(true);
  memoryCache.set(fallbackKey(key), result, FALLBACK_TTL_SECONDS);
  return result;
}

/**
 * Shared resolution path for every social read: fresh cache → (disabled? mock) →
 * (breaker open? stale/demo + background retry) → single-flight interactive
 * attempt with a short deadline → stale cache → labeled demo. Real payloads
 * cache for the full TTL (plus a stale window), demo payloads cache briefly
 * under a separate key so recovery is picked up quickly.
 */
async function resolveSocial<T extends SocialPayload>(
  key: string,
  fetchReal: () => Promise<T>,
  fetchMock: () => Promise<T>,
): Promise<T> {
  const cached = memoryCache.get<T>(key);
  if (cached) return cached;

  // A recent demo payload short-circuits the provider during an outage — but
  // only while there is no stale REAL payload worth preferring over it.
  const cachedFallback = memoryCache.get<T>(fallbackKey(key));
  if (cachedFallback && !memoryCache.getStale<T>(key)) {
    // Re-label if we have since learned the actual cause (e.g. a rate limit
    // reported by a background attempt after this payload was cached).
    if (!isDisabled() && lastFallbackReason) {
      return {
        ...cachedFallback,
        warning: mockWarning(env.SOCIAL_DATA_PROVIDER, lastFallbackReason),
      };
    }
    return cachedFallback;
  }

  // Disabled provider → always demo.
  if (isDisabled()) {
    const result = await fetchMock();
    result.warning = DISABLED_WARNING;
    recordSuccess(true);
    memoryCache.set(fallbackKey(key), result, FALLBACK_TTL_SECONDS);
    return result;
  }

  const provider = getSocialDataProvider();

  // Breaker open → answer immediately from stale/demo, warm real data in the
  // background. The background call is single-flighted too, so an open breaker
  // can never stack up upstream jobs.
  if (breakerOpen()) {
    revalidateInBackground(key, provider.name, singleFlight(key, fetchReal));
    // Keep naming the ACTUAL cause (e.g. a rate limit) while the breaker rides
    // out the outage — "temporarily unavailable" only when we never knew why.
    return staleOrMock(key, provider.name, fetchMock, lastFallbackReason ?? "breaker");
  }

  // Interactive attempt: shared with any identical concurrent request, bounded
  // by the short deadline.
  const work = singleFlight(key, fetchReal);
  try {
    const result = await withDeadline(provider.name, work, PROVIDER_INTERACTIVE_DEADLINE_MS);
    recordProviderOk();
    recordSuccess(result.isMock);
    if (result.isMock) memoryCache.set(fallbackKey(key), result, FALLBACK_TTL_SECONDS);
    else memoryCache.set(key, result, TTL);
    return result;
  } catch (err) {
    const msg = recordError(err);
    const timedOut = err instanceof ProviderTimeoutError;
    const misconfigured = /not configured/i.test(msg);
    // Misconfiguration is not a transient fault — don't trip the breaker on it.
    if (!misconfigured) recordProviderFailure();
    // A slow-but-alive provider keeps running; reuse that same work promise to
    // warm real data in the background rather than issuing a second upstream call.
    if (timedOut) revalidateInBackground(key, provider.name, work);

    const reason: FallbackReason = timedOut
      ? "timeout"
      : misconfigured
        ? "misconfigured"
        : isRateLimitFailure(err)
          ? "rate_limit"
          : "failure";
    // A timeout says nothing about the cause, so it must not erase a known one.
    if (!timedOut) lastFallbackReason = reason;

    return staleOrMock(key, provider.name, fetchMock, reason);
  }
}

/**
 * Cross-subreddit pulse. Always resolves (stale cache, then mock fallback).
 *
 * Cache key: `pulse:<provider>:<timeframe>:<q>` — e.g. `pulse:mindcase:24h:`.
 * The provider segment keeps demo and live payloads from sharing an entry when
 * SOCIAL_DATA_PROVIDER changes. Every caller of this function (the /pulse route
 * AND the dashboard ticker strip) shares this key, so they also share the cache
 * and the single-flight upstream call.
 */
export async function getSubredditPulse(params: {
  timeframe: PulseTimeframe;
  q?: string;
}): Promise<SubredditPulseResponse> {
  const key = `pulse:${env.SOCIAL_DATA_PROVIDER}:${params.timeframe}:${params.q ?? ""}`;
  return resolveSocial<SubredditPulseResponse>(
    key,
    () => getSocialDataProvider().getSubredditPulse(params),
    () => mockSocialDataProvider.getSubredditPulse(params),
  );
}

/** Ticker social feed. Always resolves (mock fallback on any failure). */
export async function getTickerSocialFeed(params: {
  ticker: string;
  timeframe: PulseTimeframe;
  q?: string;
  type?: SocialContentType | "all";
  sentiment?: SocialSentiment | "all";
  subreddit?: string | "all";
  sort?: SocialFeedSort;
}): Promise<TickerSocialFeedResponse> {
  const key =
    `ticker-social:${env.SOCIAL_DATA_PROVIDER}:${params.ticker}:${params.timeframe}:` +
    `${params.type ?? "all"}:${params.sentiment ?? "all"}:${params.subreddit ?? "all"}:` +
    `${params.sort ?? "newest"}:${params.q ?? ""}`;
  return resolveSocial<TickerSocialFeedResponse>(
    key,
    () => getSocialDataProvider().getTickerSocialFeed(params),
    () => mockSocialDataProvider.getTickerSocialFeed(params),
  );
}

/** Drop every cached payload. Used by tests and on provider/config changes. */
export function clearSocialCache(): void {
  memoryCache.clear();
}

/**
 * Operational job (QA-202): drop cached social payloads, reset the breaker, and
 * re-warm the tracked timeframes so the next public request is served from a
 * fresh cache. Tolerates provider failure (each warm falls back to labeled demo)
 * and returns per-timeframe evidence for logging.
 */
export async function refreshSocialCache(): Promise<{
  cleared: boolean;
  warmed: Array<{
    timeframe: PulseTimeframe;
    provider: string;
    isMock: boolean;
    updatedAt: string;
  }>;
}> {
  clearSocialCache();
  // A manual refresh should always get a genuine attempt.
  recordProviderOk();

  const warmed: Array<{
    timeframe: PulseTimeframe;
    provider: string;
    isMock: boolean;
    updatedAt: string;
  }> = [];

  for (const timeframe of PULSE_TIMEFRAMES) {
    const r = await getSubredditPulse({ timeframe });
    warmed.push({
      timeframe,
      provider: r.provider,
      isMock: r.isMock,
      updatedAt: r.updatedAt,
    });
  }

  return { cleared: true, warmed };
}

export * from "./socialData.types.js";
export { TRACKED_SUBREDDITS, TRACKED_SUBREDDIT_NAMES } from "./subreddits.js";
