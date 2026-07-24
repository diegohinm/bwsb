import { env } from "../../config/env.js";
import { memoryCache } from "../cache/memoryCache.js";
import { getSocialDataProvider, mockSocialDataProvider } from "./socialDataProvider.factory.js";
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
 */

const TTL = env.SOCIAL_CACHE_TTL_SECONDS;

/** Diagnostics surfaced by /api/ingestion/status and any admin page. */
type Diagnostics = {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  usingMockFallback: boolean;
};

const diagnostics: Diagnostics = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  usingMockFallback: false,
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

/** Cross-subreddit pulse. Always resolves (mock fallback on any failure). */
export async function getSubredditPulse(params: {
  timeframe: PulseTimeframe;
  q?: string;
}): Promise<SubredditPulseResponse> {
  const key = `pulse:${env.SOCIAL_DATA_PROVIDER}:${params.timeframe}:${params.q ?? ""}`;
  const cached = memoryCache.get<SubredditPulseResponse>(key);
  if (cached) return cached;

  let result: SubredditPulseResponse;

  if (isDisabled()) {
    result = await mockSocialDataProvider.getSubredditPulse(params);
    result.warning = DISABLED_WARNING;
    recordSuccess(true);
  } else {
    const provider = getSocialDataProvider();
    try {
      result = await provider.getSubredditPulse(params);
      recordSuccess(result.isMock);
    } catch (err) {
      const msg = recordError(err);
      const misconfigured = /not configured/i.test(msg);
      result = await mockSocialDataProvider.getSubredditPulse(params);
      result.warning = misconfigured
        ? misconfiguredWarning(provider.name)
        : failureWarning(provider.name);
      recordSuccess(true);
    }
  }

  memoryCache.set(key, result, TTL);
  return result;
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
  const cached = memoryCache.get<TickerSocialFeedResponse>(key);
  if (cached) return cached;

  let result: TickerSocialFeedResponse;

  if (isDisabled()) {
    result = await mockSocialDataProvider.getTickerSocialFeed(params);
    result.warning = DISABLED_WARNING;
    recordSuccess(true);
  } else {
    const provider = getSocialDataProvider();
    try {
      result = await provider.getTickerSocialFeed(params);
      recordSuccess(result.isMock);
    } catch (err) {
      const msg = recordError(err);
      const misconfigured = /not configured/i.test(msg);
      result = await mockSocialDataProvider.getTickerSocialFeed(params);
      result.warning = misconfigured
        ? misconfiguredWarning(provider.name)
        : failureWarning(provider.name);
      recordSuccess(true);
    }
  }

  memoryCache.set(key, result, TTL);
  return result;
}

/** Drop every cached payload. Used by tests and on provider/config changes. */
export function clearSocialCache(): void {
  memoryCache.clear();
}

export * from "./socialData.types.js";
export { TRACKED_SUBREDDITS, TRACKED_SUBREDDIT_NAMES } from "./subreddits.js";
