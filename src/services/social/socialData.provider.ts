import type {
  PulseTimeframe,
  SocialContentType,
  SocialDataProviderName,
  SocialFeedSort,
  SocialPostItem,
  SocialProviderStatus,
  SocialSentiment,
  SubredditPulseResponse,
  TickerSocialFeedResponse,
} from "./socialData.types.js";

/**
 * Raw normalized items plus per-subreddit failure detail. Consumed by the
 * ingestion worker, which persists the items and computes the aggregates once
 * instead of on every API request.
 */
export interface SocialItemsResult {
  items: SocialPostItem[];
  /** Subreddits whose fetch failed. Partial results are still returned. */
  failed: string[];
  /** True when at least one failure was an upstream rate limit (429). */
  rateLimited: boolean;
  attempted: number;
}

/**
 * Contract every social data source implements. Callers depend only on this
 * interface (via the factory + service), never on a concrete provider, so the
 * upstream can be swapped by changing one env var.
 */
export interface SocialDataProvider {
  readonly name: SocialDataProviderName;

  /** Health/config of this provider. Never returns secrets. */
  getStatus(): Promise<SocialProviderStatus>;

  getSubredditPulse(params: {
    timeframe: PulseTimeframe;
    q?: string;
    subreddits?: string[];
  }): Promise<SubredditPulseResponse>;

  getTickerSocialFeed(params: {
    ticker: string;
    timeframe: PulseTimeframe;
    q?: string;
    type?: SocialContentType | "all";
    sentiment?: SocialSentiment | "all";
    subreddit?: string | "all";
    sort?: SocialFeedSort;
  }): Promise<TickerSocialFeedResponse>;

  /**
   * INGESTION ONLY — raw items for the worker to persist. Optional so a provider
   * that cannot expose raw items (or is a stub) still satisfies the contract;
   * the worker falls back to demo ingestion when it is missing.
   */
  fetchItems?(params: {
    subreddits?: string[];
    keyword?: string;
    timeframe?: PulseTimeframe;
  }): Promise<SocialItemsResult>;
}
