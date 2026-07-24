import { env } from "../../config/env.js";
import { mockSocialDataProvider } from "./mockProvider.js";
import type {
  PulseSnapshot,
  PulseTimeframe,
  SocialDataProvider,
  SocialSourceName,
} from "./types.js";

/**
 * Social data access point. Every caller goes through `getPulse` — never
 * through a provider directly — so the upstream can be swapped without touching
 * routes, and so caching and mock fallback are applied uniformly.
 *
 * Provider selection (SOCIAL_DATA_PROVIDER):
 *   off  → disabled; `getPulse` resolves to null and the UI shows an empty state
 *   mock → local demo fixtures
 *   anything else → that provider when configured, otherwise mock fallback
 */

export type ProviderStatus = {
  /** The provider requested via env. */
  configured: SocialSourceName | "off";
  /** The provider that actually serves requests right now. */
  active: SocialSourceName | "off";
  /** True when the active provider returns demo/fixture data. */
  isDemo: boolean;
  /** True when SOCIAL_DATA_PROVIDER=off. */
  isDisabled: boolean;
  /** Why we are not on the configured provider, when applicable. */
  fallbackReason: string | null;
};

/** Third-party providers and the credential they each require. */
const CREDENTIAL_BY_PROVIDER: Partial<
  Record<SocialSourceName, { key: string | undefined; envName: string }>
> = {
  mindcase: { key: env.MINDCASE_API_KEY, envName: "MINDCASE_API_KEY" },
};

export function getProviderStatus(): ProviderStatus {
  const configured = env.SOCIAL_DATA_PROVIDER;

  if (configured === "off") {
    return {
      configured: "off",
      active: "off",
      isDemo: false,
      isDisabled: true,
      fallbackReason: null,
    };
  }

  if (configured === "mock") {
    return {
      configured: "mock",
      active: "mock",
      isDemo: true,
      isDisabled: false,
      fallbackReason: null,
    };
  }

  // A real provider was requested. It is only usable once implemented AND
  // credentialed; until then we serve mock so the app keeps working.
  const credential = CREDENTIAL_BY_PROVIDER[configured];
  const fallbackReason = !credential
    ? `The ${configured} provider is not implemented yet — serving demo data.`
    : !credential.key
      ? `${credential.envName} is not set — serving demo data.`
      : `The ${configured} provider is not implemented yet — serving demo data.`;

  return {
    configured,
    active: "mock",
    isDemo: true,
    isDisabled: false,
    fallbackReason,
  };
}

function resolveProvider(): SocialDataProvider | null {
  const status = getProviderStatus();
  if (status.isDisabled) return null;
  // Only the mock provider exists today; real providers land with their own
  // implementations and are selected here.
  return mockSocialDataProvider;
}

// ── Cache ────────────────────────────────────────────────────────────────────
// Third-party social APIs are metered, so responses are cached per timeframe.
type CacheEntry = { expiresAt: number; snapshot: PulseSnapshot };
const pulseCache = new Map<string, CacheEntry>();

function cacheKey(timeframe: PulseTimeframe, source: string): string {
  return `${source}:${timeframe}`;
}

/** Drop every cached payload. Used by tests and by admin/provider changes. */
export function clearSocialCache(): void {
  pulseCache.clear();
}

/**
 * Cross-subreddit pulse for a timeframe.
 * Resolves to `null` when the provider is disabled — callers must render an
 * explicit empty state rather than inventing data.
 */
export async function getPulse(
  timeframe: PulseTimeframe,
): Promise<PulseSnapshot | null> {
  const status = getProviderStatus();
  const provider = resolveProvider();
  if (!provider) return null;

  const key = cacheKey(timeframe, provider.name);
  const cached = pulseCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.snapshot;

  let snapshot: PulseSnapshot;
  try {
    snapshot = await provider.getPulse({ timeframe });
  } catch (err) {
    console.error(`Social provider "${provider.name}" failed:`, err);
    // Never let a provider outage break the page — fall back to fixtures.
    if (provider.name === "mock") throw err;
    snapshot = await mockSocialDataProvider.getPulse({ timeframe });
    snapshot.fallbackReason = `The ${provider.name} provider failed — serving demo data.`;
  }

  if (status.fallbackReason && !snapshot.fallbackReason) {
    snapshot.fallbackReason = status.fallbackReason;
  }

  pulseCache.set(key, {
    snapshot,
    expiresAt: now + env.SOCIAL_CACHE_TTL_SECONDS * 1000,
  });
  return snapshot;
}

export * from "./types.js";
export { TRACKED_SUBREDDITS, TRACKED_SUBREDDIT_NAMES } from "./subreddits.js";
