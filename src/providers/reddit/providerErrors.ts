import type { RedditProviderName } from "./types.js";

/**
 * Typed provider failures.
 *
 * The `kind` is what makes composition possible: `FallbackRedditProvider` has
 * to distinguish "the upstream is having a bad time, try the other one" from
 * "we sent a malformed request, trying again elsewhere would be equally wrong".
 */
export type RedditProviderErrorKind =
  /** HTTP 429 — the upstream asked us to slow down. */
  | "rate_limit"
  /** Request aborted by our own timeout. */
  | "timeout"
  /** HTTP 5xx. */
  | "server"
  /** DNS/socket/TLS failure — never reached the upstream. */
  | "network"
  /** HTTP 4xx other than 429 — our request was rejected. */
  | "client"
  /** HTTP 422 — the upstream parsed our request and refused its contents. */
  | "upstream_validation"
  /** Credentials or base URL missing; this provider cannot run at all. */
  | "not_configured"
  /** The upstream answered, but not with something we can parse. */
  | "invalid_response"
  /** An async job never produced results inside its poll budget. */
  | "job_timeout";

export class RedditProviderError extends Error {
  readonly provider: RedditProviderName;
  readonly kind: RedditProviderErrorKind;
  readonly status?: number;
  /**
   * The upstream's parsed error body, when it sent one.
   *
   * SERVER-SIDE ONLY. It exists so a provider can read a 422 and say WHICH
   * field was rejected; it is never serialized into an HTTP response — the
   * scanner sends `toObservedError()`, which carries a code and a sanitized
   * sentence and nothing else.
   */
  readonly details?: unknown;
  /**
   * Seconds the upstream asked us to wait, parsed from `Retry-After` on a 429.
   *
   * The Arctic Shift worker persists this as a hard block; without it a 429
   * would only ever be "wait the usual interval", which is not what the header
   * means.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    provider: RedditProviderName,
    kind: RedditProviderErrorKind,
    message: string,
    status?: number,
    extras: { details?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "RedditProviderError";
    this.provider = provider;
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (extras.details !== undefined) this.details = extras.details;
    if (extras.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = extras.retryAfterSeconds;
    }
  }

  /** Compact, secret-free description for logs and the status endpoint. */
  describe(): string {
    return this.status ? `HTTP ${this.status}` : this.kind;
  }
}

/** Raised when every provider in a composite failed. */
export class AllRedditProvidersFailedError extends Error {
  readonly failures: { provider: RedditProviderName; message: string }[];

  constructor(failures: { provider: RedditProviderName; message: string }[]) {
    super(
      `All Reddit providers failed: ${failures
        .map((f) => `${f.provider} (${f.message})`)
        .join("; ")}`,
    );
    this.name = "AllRedditProvidersFailedError";
    this.failures = failures;
  }
}

/**
 * Kinds that justify trying the secondary provider.
 *
 * A `client` error (HTTP 400, a bad subreddit name, a malformed filter) and an
 * `upstream_validation` error (HTTP 422, a payload the upstream refused) are
 * deliberately EXCLUDED: the same request would fail the same way against the
 * other upstream, and silently doubling the cost of a bug helps nobody.
 */
const FALLBACK_ELIGIBLE: ReadonlySet<RedditProviderErrorKind> = new Set([
  "rate_limit",
  "timeout",
  "server",
  "network",
  "not_configured",
  "invalid_response",
  "job_timeout",
]);

/** Whether an error means "ask the other provider instead". */
export function isFallbackEligibleError(error: unknown): boolean {
  if (error instanceof RedditProviderError) {
    return FALLBACK_ELIGIBLE.has(error.kind);
  }
  // An unclassified throw (a bug, an upstream client library) is treated as a
  // transient outage: serving data from the other provider beats serving none.
  return true;
}

/**
 * Strip anything credential-shaped out of free text.
 *
 * Used on every string that crosses a boundary — a log line, the status
 * endpoint, `worker_runs`, an upstream error body echoed back to the scanner.
 */
export function sanitizeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^\s&"',}]+/gi, "$1=***");
}

/** Same, for anything thrown. Never returns a stack trace. */
export function sanitizeProviderError(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error));
}
