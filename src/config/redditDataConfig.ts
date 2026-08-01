import "dotenv/config";

import type {
  RedditDataMode,
  RedditProviderName,
} from "../providers/reddit/types.js";

/**
 * Reddit data provider configuration — the single place that turns environment
 * variables into a validated, typed description of WHICH upstream(s) the
 * ingestion worker may talk to.
 *
 * Switching providers is an `.env` change and nothing else:
 *
 *   REDDIT_DATA_MODE=mindcase      only Mindcase, Arctic Shift is never called
 *   REDDIT_DATA_MODE=arctic_shift  only Arctic Shift, Mindcase is never called
 *   REDDIT_DATA_MODE=hybrid        both, merged and de-duplicated by Reddit id
 *   REDDIT_DATA_MODE=fallback      primary first, secondary only when it fails
 *
 * DESIGN NOTES
 *  - `buildRedditDataConfig` is PURE: it reads from the object it is handed
 *    (`process.env` by default), so tests can validate arbitrary combinations
 *    without touching the real environment.
 *  - Validation THROWS `RedditDataConfigError` with an actionable message.
 *    Resolution is LAZY (`getRedditDataConfig`, memoized) so an invalid
 *    configuration surfaces on first use — the worker records a failed run and
 *    the API keeps serving database snapshots — instead of taking a process
 *    down at import time.
 *  - A missing MINDCASE_API_KEY is NOT a configuration error unless Mindcase is
 *    the only possible data path; the provider simply reports itself
 *    unavailable and the other provider (or the last stored data) carries the
 *    app. See providers/reddit/MindcaseProvider.ts.
 *  - Nothing here is ever logged with its value: only variable NAMES appear in
 *    error messages, never keys.
 */

export const REDDIT_DATA_MODES: readonly RedditDataMode[] = [
  "mindcase",
  "arctic_shift",
  "hybrid",
  "fallback",
];

export const REDDIT_PROVIDER_NAMES: readonly RedditProviderName[] = [
  "mindcase",
  "arctic_shift",
];

/** Raised when the environment describes an impossible provider setup. */
export class RedditDataConfigError extends Error {
  constructor(message: string) {
    super(`Invalid Reddit provider configuration: ${message}`);
    this.name = "RedditDataConfigError";
  }
}

export interface MindcaseConfig {
  /** Server-side only. Absent means "Mindcase cannot be called". */
  apiKey?: string;
  baseUrl: string;
  pollIntervalMs: number;
  maxPollAttempts: number;
}

export interface ArcticShiftConfig {
  baseUrl: string;
  requestDelayMs: number;
}

export interface RedditDataConfig {
  mode: RedditDataMode;
  primaryProvider: RedditProviderName;
  fallbackProvider: RedditProviderName;

  enabled: {
    mindcase: boolean;
    arcticShift: boolean;
  };

  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;

  deduplicateResults: boolean;
  storeSourceMetadata: boolean;
  /** In `fallback` mode, treat an empty primary result as a reason to fall back. */
  fallbackOnEmpty: boolean;

  mindcase: MindcaseConfig;
  arcticShift: ArcticShiftConfig;

  /**
   * Providers this mode may actually instantiate, in priority order. Disabled
   * providers are never constructed and never called.
   */
  activeProviders: RedditProviderName[];
}

/**
 * Includes the API version: every Mindcase path this app calls
 * (`/agents/reddit/posts/run`, `/jobs/{id}/results`) hangs off the versioned
 * root, and a base URL without it produces 404s and 422s.
 */
const DEFAULT_MINDCASE_BASE_URL = "https://api.mindcase.co/api/v1";
const DEFAULT_ARCTIC_SHIFT_BASE_URL = "https://arctic-shift.photon-reddit.com";

/** Environment source: anything with string-ish values keyed by name. */
type EnvSource = Record<string, string | undefined>;

function raw(source: EnvSource, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Boolean env var. Accepts true/false/1/0/yes/no in any case; anything else is
 * a configuration error rather than a silent `false` — an operator typing
 * `REDDIT_ENABLE_MINDCASE=tru` must be told, not quietly ignored.
 */
function bool(source: EnvSource, key: string, fallback: boolean): boolean {
  const value = raw(source, key);
  if (value === undefined) return fallback;
  const lowered = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "off"].includes(lowered)) return false;
  throw new RedditDataConfigError(
    `${key} must be true or false (got an unrecognized value).`,
  );
}

/** Integer env var with a documented range. Out-of-range/NaN is an error. */
function int(
  source: EnvSource,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw(source, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new RedditDataConfigError(`${key} must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new RedditDataConfigError(
      `${key} must be between ${min} and ${max} (got ${parsed}).`,
    );
  }
  return parsed;
}

function url(source: EnvSource, key: string, fallback: string): string {
  const value = raw(source, key) ?? fallback;
  try {
    // Validate, then drop trailing slashes so path joins stay predictable.
    new URL(value);
  } catch {
    throw new RedditDataConfigError(`${key} must be a valid absolute URL.`);
  }
  return value.replace(/\/+$/, "");
}

/**
 * Mindcase's API root, guaranteed to carry the version segment exactly once.
 *
 * Operators set MINDCASE_BASE_URL both ways — `https://api.mindcase.co` and
 * `https://api.mindcase.co/api/v1`. Both must end up at the same place: the
 * bare form otherwise misses the version, and blindly appending would produce
 * `/api/v1/api/v1/agents/reddit/posts/run`.
 */
function mindcaseBaseUrl(source: EnvSource): string {
  const base = url(source, "MINDCASE_BASE_URL", DEFAULT_MINDCASE_BASE_URL);
  return /\/api\/v\d+$/i.test(base) ? base : `${base}/api/v1`;
}

function providerName(
  source: EnvSource,
  key: string,
  fallback: RedditProviderName,
): RedditProviderName {
  const value = raw(source, key);
  if (value === undefined) return fallback;
  if (!(REDDIT_PROVIDER_NAMES as string[]).includes(value)) {
    throw new RedditDataConfigError(
      `${key} must be one of: ${REDDIT_PROVIDER_NAMES.join(", ")} (got "${value}").`,
    );
  }
  return value as RedditProviderName;
}

/** Whether a provider is switched on, by canonical provider name. */
export function isProviderEnabled(
  config: RedditDataConfig,
  name: RedditProviderName,
): boolean {
  return name === "mindcase" ? config.enabled.mindcase : config.enabled.arcticShift;
}

/**
 * Read + validate the Reddit provider configuration.
 *
 * Defaults are deliberately conservative: with NOTHING set the app runs in
 * `arctic_shift` mode, the only provider that needs no API key, so a fresh
 * checkout ingests data without provisioning credentials first.
 */
export function buildRedditDataConfig(
  source: EnvSource = process.env,
): RedditDataConfig {
  const modeValue = raw(source, "REDDIT_DATA_MODE") ?? "arctic_shift";
  if (!(REDDIT_DATA_MODES as string[]).includes(modeValue)) {
    throw new RedditDataConfigError(
      `REDDIT_DATA_MODE must be one of: ${REDDIT_DATA_MODES.join(", ")} (got "${modeValue}").`,
    );
  }
  const mode = modeValue as RedditDataMode;

  const primaryProvider = providerName(
    source,
    "REDDIT_PRIMARY_PROVIDER",
    "arctic_shift",
  );
  const fallbackProvider = providerName(
    source,
    "REDDIT_FALLBACK_PROVIDER",
    "mindcase",
  );

  const enabled = {
    mindcase: bool(source, "REDDIT_ENABLE_MINDCASE", true),
    arcticShift: bool(source, "REDDIT_ENABLE_ARCTIC_SHIFT", true),
  };

  const config: RedditDataConfig = {
    mode,
    primaryProvider,
    fallbackProvider,
    enabled,

    timeoutMs: int(source, "REDDIT_PROVIDER_TIMEOUT_MS", 30_000, 1_000, 300_000),
    maxRetries: int(source, "REDDIT_PROVIDER_MAX_RETRIES", 3, 0, 10),
    retryDelayMs: int(source, "REDDIT_PROVIDER_RETRY_DELAY_MS", 5_000, 100, 60_000),

    deduplicateResults: bool(source, "REDDIT_DEDUPLICATE_RESULTS", true),
    storeSourceMetadata: bool(source, "REDDIT_STORE_SOURCE_METADATA", true),
    fallbackOnEmpty: bool(source, "REDDIT_FALLBACK_ON_EMPTY", true),

    mindcase: {
      ...(raw(source, "MINDCASE_API_KEY")
        ? { apiKey: raw(source, "MINDCASE_API_KEY") as string }
        : {}),
      baseUrl: mindcaseBaseUrl(source),
      pollIntervalMs: int(source, "MINDCASE_POLL_INTERVAL_MS", 5_000, 250, 60_000),
      // MINDCASE_MAX_POLLS is the legacy name used by the social provider; it is
      // honoured so a single deployment does not need both variables.
      maxPollAttempts: int(
        source,
        raw(source, "MINDCASE_MAX_POLL_ATTEMPTS") !== undefined
          ? "MINDCASE_MAX_POLL_ATTEMPTS"
          : "MINDCASE_MAX_POLLS",
        20,
        1,
        200,
      ),
    },

    arcticShift: {
      baseUrl: url(source, "ARCTIC_SHIFT_BASE_URL", DEFAULT_ARCTIC_SHIFT_BASE_URL),
      requestDelayMs: int(source, "ARCTIC_SHIFT_REQUEST_DELAY_MS", 1_000, 0, 60_000),
    },

    activeProviders: [],
  };

  config.activeProviders = resolveActiveProviders(config);
  return config;
}

/**
 * Cross-field validation + the ordered list of providers the mode will use.
 *
 * These are the combinations that are impossible rather than merely unusual:
 * a single-provider mode whose provider is switched off, a fallback pair that
 * is the same provider twice, or a mode with nothing enabled at all.
 */
function resolveActiveProviders(config: RedditDataConfig): RedditProviderName[] {
  const { mode, primaryProvider, fallbackProvider } = config;

  switch (mode) {
    case "mindcase":
    case "arctic_shift": {
      const name: RedditProviderName = mode;
      if (!isProviderEnabled(config, name)) {
        const flag =
          name === "mindcase"
            ? "REDDIT_ENABLE_MINDCASE"
            : "REDDIT_ENABLE_ARCTIC_SHIFT";
        throw new RedditDataConfigError(
          `REDDIT_DATA_MODE=${mode} requires ${flag}=true.`,
        );
      }
      return [name];
    }

    case "hybrid": {
      const active = (REDDIT_PROVIDER_NAMES as RedditProviderName[]).filter((n) =>
        isProviderEnabled(config, n),
      );
      if (active.length === 0) {
        throw new RedditDataConfigError(
          "REDDIT_DATA_MODE=hybrid requires at least one of " +
            "REDDIT_ENABLE_MINDCASE / REDDIT_ENABLE_ARCTIC_SHIFT to be true.",
        );
      }
      // Preferred provider first: it decides `primarySource` on merged records.
      // A partition rather than a sort — a comparator built on "is preferred"
      // is not a total order and would misbehave with more than two providers.
      return [
        ...active.filter((n) => n === primaryProvider),
        ...active.filter((n) => n !== primaryProvider),
      ];
    }

    case "fallback": {
      if (primaryProvider === fallbackProvider) {
        throw new RedditDataConfigError(
          "REDDIT_PRIMARY_PROVIDER and REDDIT_FALLBACK_PROVIDER must be different " +
            `(both are "${primaryProvider}").`,
        );
      }
      if (!isProviderEnabled(config, primaryProvider)) {
        throw new RedditDataConfigError(
          `REDDIT_PRIMARY_PROVIDER=${primaryProvider} is disabled by its REDDIT_ENABLE_* flag.`,
        );
      }
      if (!isProviderEnabled(config, fallbackProvider)) {
        throw new RedditDataConfigError(
          `REDDIT_FALLBACK_PROVIDER=${fallbackProvider} is disabled by its REDDIT_ENABLE_* flag.`,
        );
      }
      return [primaryProvider, fallbackProvider];
    }

    default: {
      // Unreachable: `mode` was validated against REDDIT_DATA_MODES above.
      throw new RedditDataConfigError(`Unsupported REDDIT_DATA_MODE "${mode}".`);
    }
  }
}

let cached: RedditDataConfig | undefined;

/**
 * The process-wide configuration, resolved once on first use.
 *
 * Lazy on purpose — see the module header. Call `resetRedditDataConfig()` in
 * tests that mutate `process.env`.
 */
export function getRedditDataConfig(): RedditDataConfig {
  if (!cached) cached = buildRedditDataConfig();
  return cached;
}

/** Testing hook: drop the memoized configuration. */
export function resetRedditDataConfig(): void {
  cached = undefined;
}

/** One-line, secret-free summary for the worker banner and the status route. */
export function describeRedditDataConfig(config: RedditDataConfig): string {
  return `mode=${config.mode} providers=${config.activeProviders.join(",")}`;
}
