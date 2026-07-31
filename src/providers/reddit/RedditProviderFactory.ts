import {
  describeRedditDataConfig,
  getRedditDataConfig,
  type RedditDataConfig,
} from "../../config/redditDataConfig.js";
import { ArcticShiftProvider } from "./ArcticShiftProvider.js";
import { FallbackRedditProvider } from "./FallbackRedditProvider.js";
import { HybridRedditProvider } from "./HybridRedditProvider.js";
import { MindcaseProvider } from "./MindcaseProvider.js";
import { getProvidersHealth } from "./providerHealth.js";
import type { RedditDataProvider } from "./RedditDataProvider.js";
import type {
  RedditDataMode,
  RedditProviderHealth,
  RedditProviderName,
} from "./types.js";

/**
 * Turn the validated configuration into ONE provider object.
 *
 * This is the only place that knows which concrete classes exist. The
 * ingestion service imports `getRedditDataProvider()` and nothing else, so
 * changing `REDDIT_DATA_MODE` in `.env` swaps the entire data path without
 * touching a line of application code.
 *
 * DISABLED PROVIDERS ARE NEVER CONSTRUCTED. In `arctic_shift` mode no Mindcase
 * object exists, so no code path — not even a buggy one — can reach Mindcase.
 *
 * The instance is a memoized SINGLETON. It is built on first use rather than at
 * import time: a configuration error then surfaces as a failed worker run or a
 * 500 on the internal status route, instead of preventing a process from
 * booting at all.
 */

/** Build the provider described by `config`. Exported for tests. */
export function createRedditDataProvider(
  config: RedditDataConfig = getRedditDataConfig(),
): RedditDataProvider {
  const provider = build(config);
  console.log(`[RedditProvider] ${describeRedditDataConfig(config)}`);
  return provider;
}

function build(config: RedditDataConfig): RedditDataProvider {
  switch (config.mode) {
    case "mindcase":
      return new MindcaseProvider(config);

    case "arctic_shift":
      return new ArcticShiftProvider(config);

    case "hybrid": {
      // Only the enabled providers, ordered with the preferred one first.
      const providers = config.activeProviders.map((name) =>
        instantiate(name, config),
      );
      return new HybridRedditProvider(providers, {
        preferredSource: config.activeProviders[0] ?? config.primaryProvider,
        deduplicate: config.deduplicateResults,
      });
    }

    case "fallback":
      return new FallbackRedditProvider(
        instantiate(config.primaryProvider, config),
        instantiate(config.fallbackProvider, config),
        { fallbackOnEmpty: config.fallbackOnEmpty },
      );

    default: {
      // Unreachable — redditDataConfig validated the mode.
      const unexpected: never = config.mode;
      throw new Error(`Unsupported REDDIT_DATA_MODE "${String(unexpected)}".`);
    }
  }
}

function instantiate(
  name: RedditProviderName,
  config: RedditDataConfig,
): RedditDataProvider {
  return name === "mindcase"
    ? new MindcaseProvider(config)
    : new ArcticShiftProvider(config);
}

let instance: RedditDataProvider | undefined;

/**
 * The process-wide Reddit data provider. Created once, on first use — never
 * per request, and never per worker tick.
 */
export function getRedditDataProvider(): RedditDataProvider {
  if (!instance) instance = createRedditDataProvider();
  return instance;
}

/** Testing hook: drop the memoized provider. */
export function resetRedditDataProvider(): void {
  instance = undefined;
}

export interface RedditProvidersStatus {
  mode: RedditDataMode;
  primaryProvider: RedditProviderName;
  fallbackProvider: RedditProviderName | null;
  deduplicateResults: boolean;
  storeSourceMetadata: boolean;
  providers: (RedditProviderHealth & { enabled: boolean; configured: boolean })[];
}

/**
 * Mode + per-provider health for `GET /api/internal/reddit/providers/status`.
 *
 * Reads configuration and in-process counters only: it never touches the
 * network, so calling it can never make a degraded provider worse.
 */
export function getRedditProvidersStatus(
  config: RedditDataConfig = getRedditDataConfig(),
): RedditProvidersStatus {
  const health = getProvidersHealth(config.activeProviders);

  return {
    mode: config.mode,
    primaryProvider: config.primaryProvider,
    fallbackProvider: config.mode === "fallback" ? config.fallbackProvider : null,
    deduplicateResults: config.deduplicateResults,
    storeSourceMetadata: config.storeSourceMetadata,
    providers: health.map((entry) => ({
      ...entry,
      enabled: true,
      configured:
        entry.provider === "mindcase"
          ? Boolean(config.mindcase.apiKey)
          : Boolean(config.arcticShift.baseUrl),
    })),
  };
}
