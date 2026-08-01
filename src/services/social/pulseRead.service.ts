import { memoryCache } from "../cache/memoryCache.js";
import {
  readLatestPulseMeta,
  readSocialItems,
} from "../../repositories/socialSnapshots.repository.js";
import { mockSocialDataProvider } from "./socialDataProvider.factory.js";
import { assemblePulseResponse, assembleTickerFeed } from "./socialData.assemble.js";
import { TRACKED_SUBREDDIT_NAMES } from "./subreddits.js";
import {
  PULSE_TIMEFRAME_MS,
  type PulseTimeframe,
  type SocialContentType,
  type SocialFeedSort,
  type SocialSentiment,
  type SubredditPulseResponse,
  type TickerSocialFeedResponse,
} from "./socialData.types.js";

/**
 * API-side social reads — DATABASE ONLY.
 *
 * The API process never calls Mindcase. The ingestion worker stores normalized
 * items in `social_posts` / `social_comments` and per-subreddit metrics in
 * `subreddit_pulse_snapshots`; this module rebuilds the API response from those
 * rows using the SAME aggregator/assembler the worker used, so the response
 * contract is identical to the provider-backed one the frontend already knows.
 *
 * Provenance comes from the stored snapshot: `provider`, `source`, `isMock` and
 * `updatedAt` describe the WORKER'S last run, not the moment of the request — a
 * stale feed is therefore visible as stale.
 *
 * A short in-process cache keeps repeated dashboard/Pulse hits from re-running
 * the aggregation; it is a CPU cache over the database, not a provider cache.
 */

/** Aggregation cache TTL. Well under any ingestion interval. */
const READ_CACHE_SECONDS = 30;

const WARN_NO_DATA =
  "No ingested social data yet — the ingestion worker has not published a snapshot. Showing demo data.";

/** Items are capped so one huge window can't blow up an API request. */
const MAX_ITEMS = 2_000;

function windowStart(timeframe: PulseTimeframe): string {
  return new Date(Date.now() - PULSE_TIMEFRAME_MS[timeframe]).toISOString();
}

/**
 * Cross-subreddit pulse rebuilt from stored items. Falls back to labeled demo
 * data when the worker has published nothing for this window.
 *
 * `subreddits` (already normalized+validated by the route) scopes the whole
 * response: the DB read, every aggregate and the cache entry. Omitted means all
 * tracked communities.
 */
export async function getStoredSubredditPulse(params: {
  timeframe: PulseTimeframe;
  q?: string;
  subreddits?: readonly string[];
}): Promise<SubredditPulseResponse> {
  const selected = params.subreddits?.length
    ? [...params.subreddits]
    : [...TRACKED_SUBREDDIT_NAMES];
  const isSubset = selected.length < TRACKED_SUBREDDIT_NAMES.length;

  // Sorted, so `stocks,wallstreetbets` and `wallstreetbets,stocks` are one entry.
  const key =
    `pulse-db:${params.timeframe}:${[...selected].sort().join(",")}:q=${params.q ?? ""}`;
  const cached = memoryCache.get<SubredditPulseResponse>(key);
  if (cached) return cached;

  const [items, meta] = await Promise.all([
    readSocialItems({
      sinceIso: windowStart(params.timeframe),
      limit: MAX_ITEMS,
      subreddits: selected,
    }),
    readLatestPulseMeta(params.timeframe),
  ]);

  let response: SubredditPulseResponse;
  // Nothing stored at all → demo data, as before. But when a SUBSET is selected
  // and the worker has published (meta exists), an empty result is a real answer
  // — "these communities were quiet" — not a reason to show demo data from
  // communities the user deselected.
  if (items.length === 0 && !(isSubset && meta)) {
    response = await mockSocialDataProvider.getSubredditPulse({
      timeframe: params.timeframe,
      ...(params.q ? { q: params.q } : {}),
      subreddits: selected,
    });
    response.warning = WARN_NO_DATA;
  } else {
    response = assemblePulseResponse(
      items,
      params.timeframe,
      params.q,
      {
        provider: (meta?.provider ??
          items[0]?.provider ??
          "mock") as SubredditPulseResponse["provider"],
        source: meta?.source ?? items[0]?.source ?? "mock",
        isMock: meta?.isMock ?? items[0]?.provider === "mock",
        // The worker's snapshot time, so the UI shows when data was last ingested.
        updatedAt: meta?.snapshotAt ?? new Date().toISOString(),
        ...(meta?.warning ? { warning: meta.warning } : {}),
      },
      selected,
    );
  }

  memoryCache.set(key, response, READ_CACHE_SECONDS);
  return response;
}

/** Ticker social feed rebuilt from stored items. */
export async function getStoredTickerSocialFeed(params: {
  ticker: string;
  timeframe: PulseTimeframe;
  q?: string;
  type?: SocialContentType | "all";
  sentiment?: SocialSentiment | "all";
  subreddit?: string | "all";
  sort?: SocialFeedSort;
}): Promise<TickerSocialFeedResponse> {
  const key =
    `ticker-social-db:${params.ticker}:${params.timeframe}:${params.type ?? "all"}:` +
    `${params.sentiment ?? "all"}:${params.subreddit ?? "all"}:${params.sort ?? "newest"}:${params.q ?? ""}`;
  const cached = memoryCache.get<TickerSocialFeedResponse>(key);
  if (cached) return cached;

  const subreddit =
    params.subreddit && params.subreddit !== "all"
      ? params.subreddit.replace(/^r\//i, "")
      : undefined;

  const [items, meta] = await Promise.all([
    readSocialItems({
      sinceIso: windowStart(params.timeframe),
      limit: MAX_ITEMS,
      ticker: params.ticker,
      subreddit,
    }),
    readLatestPulseMeta(params.timeframe),
  ]);

  let response: TickerSocialFeedResponse;
  if (items.length === 0 && !meta) {
    response = await mockSocialDataProvider.getTickerSocialFeed(params);
    response.warning = WARN_NO_DATA;
  } else {
    response = assembleTickerFeed(items, params, {
      provider: (meta?.provider ?? items[0]?.provider ?? "mock") as TickerSocialFeedResponse["provider"],
      source: meta?.source ?? items[0]?.source ?? "mock",
      isMock: meta?.isMock ?? true,
      updatedAt: meta?.snapshotAt ?? new Date().toISOString(),
      ...(meta?.warning ? { warning: meta.warning } : {}),
    });
  }

  memoryCache.set(key, response, READ_CACHE_SECONDS);
  return response;
}
