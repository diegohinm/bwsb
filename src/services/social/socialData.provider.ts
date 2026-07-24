import type {
  PulseTimeframe,
  SocialContentType,
  SocialDataProviderName,
  SocialFeedSort,
  SocialProviderStatus,
  SocialSentiment,
  SubredditPulseResponse,
  TickerSocialFeedResponse,
} from "./socialData.types.js";

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
}
