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
 * A BACKGROUND revalidation may wait longer — nobody is blocked on it, and a
 * slow-but-alive provider still warms real data into the cache for next time.
 */
const PROVIDER_BACKGROUND_DEADLINE_MS = 12_000;

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
}

// ── Background single-flight revalidation ────────────────────────────────────
const inFlight = new Set<string>();

/** Minimal shape every social payload shares. */
interface SocialPayload {
  isMock: boolean;
  warning?: string;
}

/**
 * Warm real data into the cache in the background without blocking anyone. Only
 * one revalidation runs per cache key at a time; a duplicate `work` promise is
 * swallowed so it never becomes an unhandled rejection.
 */
function revalidateInBackground<T extends SocialPayload>(
  key: string,
  providerName: string,
  work: Promise<T>,
): void {
  if (inFlight.has(key)) {
    work.catch(() => {});
    return;
  }
  inFlight.add(key);
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
    })
    .finally(() => {
      inFlight.delete(key);
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

function misconfiguredWarning(provider: string): string {
  return `${provider} provider is not configured. Showing demo data.`;
}

function failureWarning(provider: string): string {
  return `${provider} provider is unavailable. Showing demo data.`;
}

function timeoutWarning(provider: string): string {
  return `${provider} provider is taking too long. Showing demo data — retrying live data in the background.`;
}

function breakerWarning(provider: string): string {
  return `${provider} provider is temporarily unavailable. Showing demo data — retrying live data in the background.`;
}

/**
 * Shared resolution path for every social read: cache → (disabled? mock) →
 * (breaker open? instant demo + background retry) → interactive attempt with a
 * short deadline → labeled demo fallback. Real payloads cache for the full TTL,
 * demo payloads cache briefly so recovery is picked up quickly.
 */
async function resolveSocial<T extends SocialPayload>(
  key: string,
  fetchReal: () => Promise<T>,
  fetchMock: () => Promise<T>,
): Promise<T> {
  const cached = memoryCache.get<T>(key);
  if (cached) return cached;

  // Disabled provider → always demo.
  if (isDisabled()) {
    const result = await fetchMock();
    result.warning = DISABLED_WARNING;
    recordSuccess(true);
    memoryCache.set(key, result, FALLBACK_TTL_SECONDS);
    return result;
  }

  const provider = getSocialDataProvider();

  // Breaker open → serve demo immediately, warm real data in the background.
  if (breakerOpen()) {
    revalidateInBackground(key, provider.name, fetchReal());
    const result = await fetchMock();
    result.warning = breakerWarning(provider.name);
    recordSuccess(true);
    memoryCache.set(key, result, FALLBACK_TTL_SECONDS);
    return result;
  }

  // Interactive attempt bounded by the short deadline.
  const work = fetchReal();
  try {
    const result = await withDeadline(provider.name, work, PROVIDER_INTERACTIVE_DEADLINE_MS);
    recordProviderOk();
    recordSuccess(result.isMock);
    memoryCache.set(key, result, result.isMock ? FALLBACK_TTL_SECONDS : TTL);
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
    else work.catch(() => {});

    const result = await fetchMock();
    result.warning = timedOut
      ? timeoutWarning(provider.name)
      : misconfigured
        ? misconfiguredWarning(provider.name)
        : failureWarning(provider.name);
    recordSuccess(true);
    memoryCache.set(key, result, FALLBACK_TTL_SECONDS);
    return result;
  }
}

/** Cross-subreddit pulse. Always resolves (mock fallback on any failure). */
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
