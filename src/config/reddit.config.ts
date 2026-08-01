import "dotenv/config";

/**
 * THE subreddit list — one variable, every provider.
 *
 * `REDDIT_SUBREDDITS` is the single source of truth for which communities
 * YOLOPulse monitors. Arctic Shift, Mindcase, hybrid and fallback all read the
 * same list: which upstream fetches a community is a provider decision, the set
 * of communities is not. There is deliberately no ARCTIC_SHIFT_SUBREDDITS or
 * MINDCASE_SUBREDDITS — two lists means two truths and a silent gap between
 * them.
 *
 *   REDDIT_SUBREDDITS=wallstreetbets,stocks,options,investing,pennystocks
 *
 * ORDER MATTERS: the worker's round-robin follows the order written here, so
 * the `.env` decides the rotation.
 *
 * CHANGES REQUIRE A WORKER RESTART. The list is parsed once, at import, and
 * frozen. Nothing watches the `.env` for changes at runtime — a rotation that
 * mutated itself mid-cycle would corrupt the persisted round-robin index.
 *
 * WHEN THE VARIABLE IS ABSENT the tracked-communities catalog
 * (services/social/subreddits.ts) is used, so an existing deployment that never
 * set the variable keeps ingesting exactly what it ingested before. An EMPTY
 * value is different: it means "explicitly nothing", and the worker refuses to
 * start rather than spin doing nothing.
 */

import { TRACKED_SUBREDDIT_NAMES } from "../services/social/subreddits.js";

/** Reddit's own rule: 3–21 chars, letters/digits/underscore. */
const SUBREDDIT_PATTERN = /^[a-z0-9_]{2,21}$/i;

/** The worker may never poll faster than this, whatever the environment says. */
export const MIN_POLL_INTERVAL_MS = 300_000;

export interface RedditConfig {
  /** Ordered, normalized, de-duplicated. The round-robin walks this array. */
  subreddits: readonly string[];
  pollIntervalMs: number;
  postLimit: number;
  cursorOverlapSeconds: number;
  initialLookbackMinutes: number;
  /** Values from REDDIT_SUBREDDITS that were rejected, verbatim. */
  invalidSubreddits: readonly string[];
  /** Where the list came from — reported in the startup banner. */
  source: "env" | "catalog";
}

/**
 * `https://www.reddit.com/r/Options/` → `options`.
 *
 * Accepts what an operator plausibly pastes: a full URL, an `r/` prefix, mixed
 * case, stray whitespace, a trailing slash or query string.
 */
export function normalizeSubreddit(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(www\.)?reddit\.com\/r\//i, "")
    .replace(/^\/?r\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\?.*$/, "")
    .trim()
    .toLowerCase();
}

export function isValidSubreddit(value: string): boolean {
  return SUBREDDIT_PATTERN.test(value);
}

/**
 * Split a comma-separated list into normalized names, keeping the rejects.
 *
 * Invalid entries are RETURNED, not silently dropped: `wall street bets` in the
 * `.env` is a typo the operator must see, and the worker refuses to start until
 * it is fixed. Order is preserved and duplicates collapse to their first
 * occurrence.
 */
export function parseSubredditList(value?: string): {
  subreddits: string[];
  invalid: string[];
} {
  if (!value) return { subreddits: [], invalid: [] };

  const subreddits: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of value.split(",")) {
    if (entry.trim().length === 0) continue;
    const normalized = normalizeSubreddit(entry);
    if (!isValidSubreddit(normalized)) {
      invalid.push(entry.trim());
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    subreddits.push(normalized);
  }

  return { subreddits, invalid };
}

/** The valid names only — the shape most callers want. */
export function parseSubreddits(value?: string): string[] {
  return parseSubredditList(value).subreddits;
}

type EnvSource = Record<string, string | undefined>;

function raw(source: EnvSource, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * A positive integer with a floor.
 *
 * An unreadable value falls back to the default rather than throwing: a typo in
 * a tuning knob must not stop ingestion. A value BELOW the floor is raised to
 * it and logged — the five-minute pacing is a promise to a free community
 * service, not a preference.
 */
function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum = 1,
  label?: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`[redditConfig] ${label ?? "value"} "${value}" is not a positive integer; using ${fallback}.`);
    return fallback;
  }
  if (parsed < minimum) {
    console.warn(
      `[redditConfig] ${label ?? "value"}=${parsed} is below the ${minimum} floor; using ${minimum}.`,
    );
    return minimum;
  }
  return parsed;
}

/**
 * Build the configuration from an environment-like object.
 *
 * Pure, so tests can assert arbitrary combinations without touching
 * `process.env`. `ARCTIC_SHIFT_*` names are accepted as aliases for the pacing
 * knobs because that is how they were first documented; the `REDDIT_*` name
 * wins when both are present.
 */
export function buildRedditConfig(source: EnvSource = process.env): RedditConfig {
  const configured = source.REDDIT_SUBREDDITS;
  const { subreddits, invalid } = parseSubredditList(configured);

  // Absent variable → the tracked catalog. Present but empty → an explicit
  // empty list, which `assertRedditSubredditsUsable` turns into a startup error.
  const useCatalog = configured === undefined && invalid.length === 0;
  const resolved = useCatalog
    ? TRACKED_SUBREDDIT_NAMES.map(normalizeSubreddit).filter(isValidSubreddit)
    : subreddits;

  return Object.freeze({
    subreddits: Object.freeze([...resolved]),
    pollIntervalMs: parsePositiveInteger(
      raw(source, "REDDIT_POLL_INTERVAL_MS", "ARCTIC_SHIFT_POLL_INTERVAL_MS"),
      MIN_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      "REDDIT_POLL_INTERVAL_MS",
    ),
    postLimit: parsePositiveInteger(
      raw(source, "REDDIT_POST_LIMIT", "ARCTIC_SHIFT_POST_LIMIT"),
      100,
      1,
      "REDDIT_POST_LIMIT",
    ),
    cursorOverlapSeconds: parsePositiveInteger(
      raw(source, "REDDIT_CURSOR_OVERLAP_SECONDS", "ARCTIC_SHIFT_CURSOR_OVERLAP_SECONDS"),
      120,
      1,
      "REDDIT_CURSOR_OVERLAP_SECONDS",
    ),
    initialLookbackMinutes: parsePositiveInteger(
      raw(source, "REDDIT_INITIAL_LOOKBACK_MINUTES", "ARCTIC_SHIFT_INITIAL_LOOKBACK_MINUTES"),
      30,
      1,
      "REDDIT_INITIAL_LOOKBACK_MINUTES",
    ),
    invalidSubreddits: Object.freeze(invalid),
    source: useCatalog ? "catalog" : "env",
  });
}

/** Raised when the configured list cannot be used to run a worker. */
export class RedditSubredditConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedditSubredditConfigError";
  }
}

/**
 * Startup gate for anything that rotates through the list.
 *
 * Called by the worker before its first cycle — never at import time, so a bad
 * value cannot stop the API process from serving stored data.
 */
export function assertRedditSubredditsUsable(
  config: RedditConfig = redditConfig,
): void {
  if (config.invalidSubreddits.length > 0) {
    const rejected = config.invalidSubreddits.map((v) => `"${v}"`).join(", ");
    throw new RedditSubredditConfigError(
      `Invalid subreddit in REDDIT_SUBREDDITS: ${rejected}`,
    );
  }
  if (config.subreddits.length === 0) {
    throw new RedditSubredditConfigError(
      "REDDIT_SUBREDDITS must contain at least one subreddit",
    );
  }
}

/** The process-wide configuration. Parsed once; changes need a restart. */
export const redditConfig: RedditConfig = buildRedditConfig();

// ── Arctic Shift worker knobs ────────────────────────────────────────────────

export interface ArcticShiftWorkerConfig {
  /** Whether the dedicated Arctic Shift loop is scheduled at all. */
  enabled: boolean;
  /** Concurrent Arctic Shift requests. Pinned to 1 — see the worker. */
  maxConcurrency: 1;
  requestTimeoutMs: number;
  /** CONSECUTIVE failures before a subreddit is cooled down; not retries. */
  maxFailuresBeforeCooldown: number;
  /** Base for the per-subreddit cooldown after that many failures. */
  retryBaseDelayMs: number;
  /** Cooldown applied to a subreddit that keeps failing. */
  subredditCooldownMs: number;
}

function boolFrom(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

export function buildArcticShiftWorkerConfig(
  source: EnvSource = process.env,
): ArcticShiftWorkerConfig {
  const retryBaseDelayMs = parsePositiveInteger(
    raw(source, "ARCTIC_SHIFT_RETRY_BASE_DELAY_MS"),
    5_000,
    1_000,
    "ARCTIC_SHIFT_RETRY_BASE_DELAY_MS",
  );

  return Object.freeze({
    enabled: boolFrom(raw(source, "ARCTIC_SHIFT_ENABLED"), false),
    // NOT configurable above 1. The whole design is one in-flight request; a
    // second one would break the 12-requests-per-hour promise.
    maxConcurrency: 1 as const,
    requestTimeoutMs: parsePositiveInteger(
      raw(source, "ARCTIC_SHIFT_REQUEST_TIMEOUT_MS"),
      30_000,
      1_000,
      "ARCTIC_SHIFT_REQUEST_TIMEOUT_MS",
    ),
    maxFailuresBeforeCooldown: parsePositiveInteger(
      raw(source, "ARCTIC_SHIFT_MAX_RETRIES"),
      3,
      1,
      "ARCTIC_SHIFT_MAX_RETRIES",
    ),
    retryBaseDelayMs,
    // Three strikes → 15 minutes off for that subreddit, so a permanently
    // broken community cannot consume every third request forever.
    subredditCooldownMs: 15 * 60 * 1000,
  });
}

export const arcticShiftWorkerConfig: ArcticShiftWorkerConfig =
  buildArcticShiftWorkerConfig();

/** One-line, secret-free summary for the worker banner. */
export function describeRedditConfig(config: RedditConfig = redditConfig): string {
  return [
    "[RedditWorker] Configuration loaded",
    `subredditCount=${config.subreddits.length}`,
    `subreddits=${config.subreddits.join(",")}`,
    `pollIntervalMs=${config.pollIntervalMs}`,
  ].join("\n");
}
