import { env } from "../../config/env.js";
import { SERVICE_ROLE } from "../../config/serviceRole.js";
import { memoryCache } from "../cache/memoryCache.js";
import {
  readLatestRunPerJob,
  readLastSuccess,
  readRecentErrors,
} from "../../repositories/workerRuns.repository.js";
import { readLatestPulseMeta } from "../../repositories/socialSnapshots.repository.js";
import { getSocialDataProvider } from "./socialDataProvider.factory.js";
import {
  getStoredSubredditPulse,
  getStoredTickerSocialFeed,
} from "./pulseRead.service.js";
import { PULSE_TIMEFRAMES } from "./socialData.types.js";
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
 * Social data access point for the API.
 *
 * TWO-PROCESS ARCHITECTURE. Since the ingestion worker was split out, this
 * module reads the DATABASE only:
 *
 *   bwsb-worker  →  Mindcase → normalize → social_posts / social_comments /
 *                   subreddit_pulse_snapshots            (jobs/refreshSocialPulse)
 *   bwsb-api     →  THIS module → assembled response      (reads only)
 *
 * No route in the API can trigger a provider call: the provider itself refuses
 * one when SERVICE_ROLE=api (see config/serviceRole.ts), and nothing here calls
 * it. Rate-limit handling, retries and 429 backoff live in the provider, which
 * only the worker drives.
 *
 * Responses carry the WORKER'S snapshot time as `updatedAt`, plus provider /
 * source / isMock, so the UI always shows how fresh the data is and whether it
 * is demo.
 */

/**
 * Cross-subreddit pulse. Reads stored snapshots; never calls a provider — a
 * community filter narrows a DATABASE query, it never triggers ingestion.
 */
export async function getSubredditPulse(params: {
  timeframe: PulseTimeframe;
  q?: string;
  subreddits?: readonly string[];
}): Promise<SubredditPulseResponse> {
  return getStoredSubredditPulse(params);
}

/** Ticker social feed. Reads stored items; never calls a provider. */
export async function getTickerSocialFeed(params: {
  ticker: string;
  timeframe: PulseTimeframe;
  q?: string;
  type?: SocialContentType | "all";
  sentiment?: SocialSentiment | "all";
  subreddit?: string | "all";
  sort?: SocialFeedSort;
}): Promise<TickerSocialFeedResponse> {
  return getStoredTickerSocialFeed(params);
}

/**
 * Configured provider health. Config-only (no network): it reports whether the
 * provider the WORKER would use is set up, so a misconfiguration is visible from
 * the API without the API ever touching the upstream.
 */
export async function getSocialProviderStatus(): Promise<SocialProviderStatus> {
  if ((env.SOCIAL_DATA_PROVIDER as string) === "off") {
    return {
      provider: "mock",
      status: "mock",
      source: "mock",
      networkAccess: false,
      message: "SOCIAL_DATA_PROVIDER=off — social ingestion disabled, serving demo data.",
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
      message: err instanceof Error ? err.message : String(err),
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Jobs whose health is surfaced on the status endpoint. */
const MARKET_JOBS = ["refreshMarketQuotes", "refreshMarketMovers"] as const;
const SOCIAL_JOBS = ["refreshSocialPulse", "refreshTickerStrip"] as const;

/**
 * GET /api/ingestion/status payload — worker health from `worker_runs` plus the
 * freshest snapshot timestamps. No secrets, no provider calls.
 */
export async function getIngestionStatus() {
  const [social, latestRuns, recentErrors] = await Promise.all([
    getSocialProviderStatus(),
    readLatestRunPerJob(),
    readRecentErrors(5),
  ]);

  const [marketSuccesses, socialSuccesses, pulseMetas] = await Promise.all([
    Promise.all(MARKET_JOBS.map((j) => readLastSuccess(j))),
    Promise.all(SOCIAL_JOBS.map((j) => readLastSuccess(j))),
    Promise.all(PULSE_TIMEFRAMES.map((tf) => readLatestPulseMeta(tf))),
  ]);

  const newest = (times: (string | null | undefined)[]): string | null =>
    times.filter((t): t is string => Boolean(t)).sort().at(-1) ?? null;

  const lastMarketSuccess = newest(marketSuccesses.map((r) => r?.finishedAt));
  const lastSocialSuccess = newest(socialSuccesses.map((r) => r?.finishedAt));
  const lastPulseSnapshot = newest(pulseMetas.map((m) => m?.snapshotAt));

  return {
    service: {
      role: SERVICE_ROLE,
      readsFrom: "database",
      configuredSocialProvider: env.SOCIAL_DATA_PROVIDER,
      configuredMarketProvider: env.MARKET_DATA_PROVIDER,
    },
    worker: {
      // The worker is "seen" if any job ever reported in.
      lastRunAt: newest(latestRuns.map((r) => r.finishedAt)),
      lastMarketSuccessAt: lastMarketSuccess,
      lastSocialSuccessAt: lastSocialSuccess,
      jobs: latestRuns.map((r) => ({
        jobName: r.jobName,
        status: r.status,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        errorMessage: r.errorMessage,
        metadata: r.metadata,
      })),
      recentErrors: recentErrors.map((r) => ({
        jobName: r.jobName,
        finishedAt: r.finishedAt,
        errorMessage: r.errorMessage,
      })),
    },
    snapshots: {
      lastPulseSnapshotAt: lastPulseSnapshot,
      pulseByTimeframe: PULSE_TIMEFRAMES.map((tf, i) => ({
        timeframe: tf,
        snapshotAt: pulseMetas[i]?.snapshotAt ?? null,
        provider: pulseMetas[i]?.provider ?? null,
        isMock: pulseMetas[i]?.isMock ?? null,
        warning: pulseMetas[i]?.warning ?? null,
      })),
    },
    social,
  };
}

/** Drop the API's read cache (aggregation cache over the DB). */
export function clearSocialCache(): void {
  memoryCache.clear();
}

/**
 * Re-warm the API read cache from the database. This does NOT fetch from a
 * provider — that is the worker's job (npm run social:refresh).
 */
export async function refreshSocialCache(): Promise<{
  cleared: boolean;
  warmed: Array<{
    timeframe: PulseTimeframe;
    provider: string;
    isMock: boolean;
    updatedAt: string;
  }>;
}> {
  clearSocialCache();
  const warmed: Array<{
    timeframe: PulseTimeframe;
    provider: string;
    isMock: boolean;
    updatedAt: string;
  }> = [];

  for (const timeframe of PULSE_TIMEFRAMES) {
    const r = await getSubredditPulse({ timeframe });
    warmed.push({
      timeframe,
      provider: r.provider,
      isMock: r.isMock,
      updatedAt: r.updatedAt,
    });
  }

  return { cleared: true, warmed };
}

export * from "./socialData.types.js";
export {
  TRACKED_SUBREDDITS,
  TRACKED_SUBREDDIT_NAMES,
  normalizeSubreddit,
  parseSubredditFilter,
} from "./subreddits.js";
