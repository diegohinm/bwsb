import { sanitizeProviderError } from "./providerErrors.js";
import type {
  RedditProviderHealth,
  RedditProviderName,
  RedditProviderStatus,
} from "./types.js";

/**
 * In-process health record for each Reddit provider.
 *
 * WHAT THIS IS FOR: operational visibility, exposed through
 * `GET /api/internal/reddit/providers/status`. It is NOT a circuit breaker and
 * it never gates a user request — the dashboard reads PostgreSQL, so a provider
 * being down slows ingestion and nothing else.
 *
 * State is per-process and resets on restart. The worker is the process that
 * actually calls providers, so the worker's view is the meaningful one.
 */

/** Consecutive failures before a provider is considered fully unavailable. */
const UNAVAILABLE_AFTER_FAILURES = 3;
/** How many recent durations feed the rolling average. */
const RESPONSE_WINDOW = 20;

interface HealthState {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  durations: number[];
  /** False when the provider reports itself misconfigured. */
  configured: boolean;
}

function emptyState(): HealthState {
  return {
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastError: null,
    durations: [],
    configured: true,
  };
}

const states = new Map<RedditProviderName, HealthState>();

function stateOf(provider: RedditProviderName): HealthState {
  let state = states.get(provider);
  if (!state) {
    state = emptyState();
    states.set(provider, state);
  }
  return state;
}

function pushDuration(state: HealthState, ms: number): void {
  state.durations.push(ms);
  if (state.durations.length > RESPONSE_WINDOW) state.durations.shift();
}

export function recordProviderSuccess(
  provider: RedditProviderName,
  durationMs: number,
): void {
  const state = stateOf(provider);
  state.lastSuccessAt = new Date();
  state.consecutiveFailures = 0;
  state.lastError = null;
  state.configured = true;
  pushDuration(state, durationMs);
}

export function recordProviderFailure(
  provider: RedditProviderName,
  error: unknown,
  durationMs?: number,
): void {
  const state = stateOf(provider);
  state.lastFailureAt = new Date();
  state.consecutiveFailures += 1;
  state.lastError = sanitizeProviderError(error);
  if (durationMs !== undefined) pushDuration(state, durationMs);
}

/** Mark a provider as unusable for configuration reasons (missing API key). */
export function recordProviderUnavailable(
  provider: RedditProviderName,
  reason: string,
): void {
  const state = stateOf(provider);
  state.configured = false;
  state.lastError = sanitizeProviderError(reason);
}

/**
 * healthy      last call succeeded (or nothing has been tried yet)
 * degraded     1-2 consecutive failures — retries may still be working
 * unavailable  misconfigured, or failing consistently
 */
function statusOf(state: HealthState): RedditProviderStatus {
  if (!state.configured) return "unavailable";
  if (state.consecutiveFailures === 0) return "healthy";
  return state.consecutiveFailures >= UNAVAILABLE_AFTER_FAILURES
    ? "unavailable"
    : "degraded";
}

function toHealth(
  provider: RedditProviderName,
  state: HealthState,
): RedditProviderHealth {
  const average =
    state.durations.length > 0
      ? Math.round(
          state.durations.reduce((sum, ms) => sum + ms, 0) / state.durations.length,
        )
      : null;

  return {
    provider,
    status: statusOf(state),
    lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: state.lastFailureAt?.toISOString() ?? null,
    consecutiveFailures: state.consecutiveFailures,
    lastError: state.lastError,
    averageResponseTimeMs: average,
  };
}

export function getProviderHealth(
  provider: RedditProviderName,
): RedditProviderHealth {
  return toHealth(provider, stateOf(provider));
}

/** Health for the providers named, in the order given. */
export function getProvidersHealth(
  providers: readonly RedditProviderName[],
): RedditProviderHealth[] {
  return providers.map((provider) => getProviderHealth(provider));
}

/** Testing hook: forget everything observed so far. */
export function resetProviderHealth(): void {
  states.clear();
}

/**
 * Time a provider call and fold the outcome into its health record.
 *
 * Errors propagate unchanged — health tracking observes, it never swallows.
 */
export async function trackProviderCall<T>(
  provider: RedditProviderName,
  call: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await call();
    recordProviderSuccess(provider, Date.now() - startedAt);
    return result;
  } catch (error) {
    recordProviderFailure(provider, error, Date.now() - startedAt);
    throw error;
  }
}
