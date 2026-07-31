import { RedditProviderError } from "./providerErrors.js";
import type { RedditProviderName } from "./types.js";

/**
 * The one HTTP path both Reddit providers use.
 *
 * Everything a metered upstream needs is here so neither provider has to
 * re-invent it: a per-attempt abort timeout, `Retry-After`-aware 429 handling,
 * exponential backoff on 5xx/network errors, and classification of the result
 * into a typed `RedditProviderError`.
 *
 * LOGGING RULE: only the method, the redacted URL and the status are ever
 * logged. Authorization headers and query-string credentials never are.
 */

/** Never sleep longer than this on a single backoff, whatever the server says. */
const MAX_BACKOFF_MS = 30_000;

export interface RequestJsonOptions {
  provider: RedditProviderName;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Abort a single attempt after this long. */
  timeoutMs: number;
  /** Retries AFTER the first attempt. 0 means "try once". */
  maxRetries: number;
  /** Base delay for the exponential backoff ladder. */
  retryDelayMs: number;
  /** Human label used in log lines, e.g. "posts search". */
  label?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hide anything credential-shaped in a URL before it reaches a log line. */
export function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of parsed.searchParams.keys()) {
      if (/key|token|secret|auth|password/i.test(key)) {
        parsed.searchParams.set(key, "***");
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return value.replace(/([?&](?:api[_-]?key|token|secret)=)[^&]+/gi, "$1***");
  }
}

/** 2s → 4s → 8s … capped, based on the caller's configured base delay. */
function backoffMs(base: number, attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, base * 2 ** attempt);
}

/**
 * How long to wait after a 429. Prefers `Retry-After` (seconds or HTTP-date)
 * and falls back to exponential backoff. Always clamped, so a hostile or odd
 * header can never park the worker for minutes.
 */
function retryAfterMs(header: string | null, base: number, attempt: number): number {
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_BACKOFF_MS, seconds * 1000);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.min(MAX_BACKOFF_MS, Math.max(0, date - Date.now()));
    }
  }
  return backoffMs(base, attempt);
}

/**
 * Perform a JSON request with retries, returning the parsed body.
 *
 * Throws `RedditProviderError` with the kind that matches what went wrong:
 *   429                        → rate_limit  (retried, then thrown)
 *   5xx                        → server      (retried, then thrown)
 *   abort                      → timeout     (retried, then thrown)
 *   fetch rejection            → network     (retried, then thrown)
 *   other 4xx                  → client      (NOT retried — our request is wrong)
 *   unparseable body           → invalid_response
 */
export async function requestJson<T>(options: RequestJsonOptions): Promise<T> {
  const {
    provider,
    url,
    method = "GET",
    headers = {},
    body,
    timeoutMs,
    maxRetries,
    retryDelayMs,
    label,
  } = options;

  const where = label ? `${label} ` : "";
  const safeUrl = redactUrl(url);
  let lastError: RedditProviderError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const isLastAttempt = attempt === maxRetries;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (response.status === 429) {
        console.warn(
          `[${providerLabel(provider)}] Rate limited status=429 retry=${attempt + 1} ${where}url=${safeUrl}`,
        );
        lastError = new RedditProviderError(
          provider,
          "rate_limit",
          `${method} ${safeUrl} -> 429`,
          429,
        );
        if (isLastAttempt) throw lastError;
        await sleep(retryAfterMs(response.headers.get("retry-after"), retryDelayMs, attempt));
        continue;
      }

      if (response.status >= 500) {
        lastError = new RedditProviderError(
          provider,
          "server",
          `${method} ${safeUrl} -> ${response.status}`,
          response.status,
        );
        if (isLastAttempt) throw lastError;
        await sleep(backoffMs(retryDelayMs, attempt));
        continue;
      }

      if (!response.ok) {
        // 4xx: our request is the problem. Retrying — here or on another
        // provider — would fail identically, so fail fast and loudly.
        throw new RedditProviderError(
          provider,
          "client",
          `${method} ${safeUrl} -> ${response.status}`,
          response.status,
        );
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new RedditProviderError(
          provider,
          "invalid_response",
          `${method} ${safeUrl} returned a body that is not valid JSON`,
        );
      }
    } catch (error) {
      if (error instanceof RedditProviderError) {
        // `client` and `invalid_response` are final; the retryable kinds were
        // already re-thrown above on the last attempt.
        if (error.kind === "client" || error.kind === "invalid_response") throw error;
        lastError = error;
        if (isLastAttempt) throw error;
        continue;
      }

      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      lastError = new RedditProviderError(
        provider,
        aborted ? "timeout" : "network",
        aborted
          ? `${method} ${safeUrl} timed out after ${timeoutMs}ms`
          : `${method} ${safeUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (isLastAttempt) throw lastError;
      await sleep(backoffMs(retryDelayMs, attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ??
    new RedditProviderError(provider, "network", `${method} ${safeUrl} failed`)
  );
}

/** `mindcase` → `MindcaseProvider`, for log prefixes. */
function providerLabel(provider: RedditProviderName): string {
  return provider === "mindcase" ? "MindcaseProvider" : "ArcticShiftProvider";
}
