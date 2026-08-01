import { RedditProviderError, sanitizeProviderError } from "./providerErrors.js";
import type { RedditProviderName } from "./types.js";

/**
 * Per-provider call reporting for the internal scanner page.
 *
 * A composite provider (hybrid, fallback) normally hides which upstream did
 * what — that is the whole point of the abstraction. The scanner test harness
 * needs exactly that hidden detail so it can show Arctic Shift and Mindcase
 * side by side, so composites accept an optional observer.
 *
 * STRICTLY OBSERVATIONAL: an observer can never change what a provider
 * returns, and production ingestion never passes one.
 */

/** Error shape safe to send to a browser: a code and a sentence, nothing else. */
export interface ObservedProviderError {
  code: string;
  message: string;
}

export interface ObservedProviderCall {
  provider: RedditProviderName;
  success: boolean;
  receivedCount: number;
  durationMs: number;
  error: ObservedProviderError | null;
}

export type ProviderCallObserver = (call: ObservedProviderCall) => void;

/** Map a provider error kind onto a stable, screaming-snake wire code. */
const KIND_TO_CODE: Record<string, string> = {
  rate_limit: "RATE_LIMITED",
  timeout: "TIMEOUT",
  server: "UPSTREAM_ERROR",
  network: "NETWORK_ERROR",
  client: "BAD_REQUEST",
  upstream_validation: "UPSTREAM_VALIDATION_FAILED",
  not_configured: "PROVIDER_NOT_CONFIGURED",
  invalid_response: "INVALID_RESPONSE",
  job_timeout: "JOB_TIMEOUT",
};

/**
 * Turn any thrown value into a client-safe error.
 *
 * NEVER carries a stack trace, and the message goes through
 * `sanitizeProviderError` so a bearer token or API key that leaked into an
 * upstream message cannot reach the browser.
 */
export function toObservedError(error: unknown): ObservedProviderError {
  if (error instanceof RedditProviderError) {
    return {
      code: KIND_TO_CODE[error.kind] ?? "PROVIDER_ERROR",
      message: sanitizeProviderError(error),
    };
  }
  return {
    code: "PROVIDER_ERROR",
    message: sanitizeProviderError(error),
  };
}

/** Collects calls for one scan. */
export function createObserverCollector(): {
  observer: ProviderCallObserver;
  calls: ObservedProviderCall[];
} {
  const calls: ObservedProviderCall[] = [];
  return {
    calls,
    observer: (call) => {
      calls.push(call);
    },
  };
}
