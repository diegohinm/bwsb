import {
  getRedditDataConfig,
  isProviderEnabled,
  type RedditDataConfig,
} from "../../config/redditDataConfig.js";
import { ArcticShiftProvider } from "./ArcticShiftProvider.js";
import { FallbackRedditProvider } from "./FallbackRedditProvider.js";
import { HybridRedditProvider } from "./HybridRedditProvider.js";
import { MindcaseProvider } from "./MindcaseProvider.js";
import type { ProviderCallObserver } from "./providerObserver.js";
import type { RedditDataProvider } from "./RedditDataProvider.js";
import { getRedditDataProvider } from "./RedditProviderFactory.js";
import type { RedditProviderName } from "./types.js";

/**
 * Build a provider for ONE test request.
 *
 * The internal scanner page lets an operator try a specific upstream without
 * touching how the app is configured. That is the entire contract of this
 * module:
 *
 *   THE PROCESS-WIDE PROVIDER IS NEVER MODIFIED. `REDDIT_DATA_MODE` is not
 *   read-modified-written, the memoized singleton in RedditProviderFactory is
 *   not replaced, and the ingestion worker keeps using whatever the environment
 *   says. A choice made on the test page affects that request and nothing else.
 *
 * `configured` is the exception that proves the rule: it returns the real
 * singleton, so the page can test exactly what production would do.
 */

export const SCANNER_PROVIDER_MODES = [
  "configured",
  "arctic_shift",
  "mindcase",
  "hybrid",
  "fallback",
] as const;

export type RedditScannerTestProvider = (typeof SCANNER_PROVIDER_MODES)[number];

export function isScannerProviderMode(
  value: unknown,
): value is RedditScannerTestProvider {
  return (
    typeof value === "string" &&
    (SCANNER_PROVIDER_MODES as readonly string[]).includes(value)
  );
}

/**
 * Raised when the operator asked for an upstream that the environment has
 * switched off. Carries the 400-level wire code the endpoint returns.
 */
export class ProviderDisabledError extends Error {
  readonly code = "PROVIDER_DISABLED";
  readonly provider: RedditProviderName;

  constructor(provider: RedditProviderName) {
    super(`${labelOf(provider)} provider is disabled`);
    this.name = "ProviderDisabledError";
    this.provider = provider;
  }
}

function labelOf(provider: RedditProviderName): string {
  return provider === "mindcase" ? "Mindcase" : "Arctic Shift";
}

/** Construct one enabled upstream, or refuse. */
function requireEnabled(
  provider: RedditProviderName,
  config: RedditDataConfig,
): RedditDataProvider {
  if (!isProviderEnabled(config, provider)) {
    throw new ProviderDisabledError(provider);
  }
  return provider === "mindcase"
    ? new MindcaseProvider(config)
    : new ArcticShiftProvider(config);
}

export interface CreateTestProviderOptions {
  /** Per-provider reporting for composites. Ignored by single providers. */
  observer?: ProviderCallObserver;
  /** Injectable for tests. Defaults to the process configuration. */
  config?: RedditDataConfig;
}

/**
 * Resolve `providerMode` into a provider instance for a single request.
 *
 * Throws `ProviderDisabledError` when the requested upstream is switched off —
 * the caller turns that into a 400 with `code: "PROVIDER_DISABLED"`.
 */
export function createTestRedditProvider(
  providerMode: RedditScannerTestProvider,
  options: CreateTestProviderOptions = {},
): RedditDataProvider {
  const config = options.config ?? getRedditDataConfig();

  switch (providerMode) {
    case "configured":
      // The real singleton — what the worker itself would use.
      return getRedditDataProvider();

    case "arctic_shift":
      return requireEnabled("arctic_shift", config);

    case "mindcase":
      return requireEnabled("mindcase", config);

    case "hybrid": {
      // Both upstreams must be available: a "hybrid" that silently ran one
      // provider would make the comparison view a lie.
      const arcticShift = requireEnabled("arctic_shift", config);
      const mindcase = requireEnabled("mindcase", config);
      return new HybridRedditProvider([arcticShift, mindcase], {
        preferredSource: config.primaryProvider,
        deduplicate: config.deduplicateResults,
        ...(options.observer ? { observer: options.observer } : {}),
      });
    }

    case "fallback": {
      if (config.primaryProvider === config.fallbackProvider) {
        throw new Error(
          "REDDIT_PRIMARY_PROVIDER and REDDIT_FALLBACK_PROVIDER are the same provider.",
        );
      }
      return new FallbackRedditProvider(
        requireEnabled(config.primaryProvider, config),
        requireEnabled(config.fallbackProvider, config),
        {
          fallbackOnEmpty: config.fallbackOnEmpty,
          ...(options.observer ? { observer: options.observer } : {}),
        },
      );
    }

    default: {
      // Unreachable — `providerMode` is validated before it reaches here.
      const unexpected: never = providerMode;
      throw new Error(`Unsupported provider mode "${String(unexpected)}".`);
    }
  }
}

/**
 * Which concrete upstreams a mode will contact. Used for the execution log and
 * the `providerUsed` field before any call is made.
 */
export function providersForMode(
  providerMode: RedditScannerTestProvider,
  config: RedditDataConfig = getRedditDataConfig(),
): RedditProviderName[] {
  switch (providerMode) {
    case "configured":
      return [...config.activeProviders];
    case "arctic_shift":
      return ["arctic_shift"];
    case "mindcase":
      return ["mindcase"];
    case "hybrid":
      return ["arctic_shift", "mindcase"];
    case "fallback":
      return [config.primaryProvider, config.fallbackProvider];
    default:
      return [];
  }
}
