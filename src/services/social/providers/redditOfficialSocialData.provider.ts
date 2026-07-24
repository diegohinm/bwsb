import type { SocialDataProvider } from "../socialData.provider.js";
import type {
  PulseTimeframe,
  SocialContentType,
  SocialFeedSort,
  SocialProviderStatus,
  SocialSentiment,
  SubredditPulseResponse,
  TickerSocialFeedResponse,
} from "../socialData.types.js";

/**
 * FUTURE PROVIDER — the official Reddit Data API. Not implemented.
 *
 * This is the only sanctioned path to first-party Reddit data (OAuth app +
 * approved API access, backend-only). Until it lands, getStatus reports
 * `misconfigured` and the service layer serves demo data. NOTE: this is the
 * official API — it is NOT scraping, which the app never does.
 */
export class RedditOfficialSocialDataProviderStub implements SocialDataProvider {
  readonly name = "reddit_official" as const;

  async getStatus(): Promise<SocialProviderStatus> {
    return {
      provider: "reddit_official",
      status: "misconfigured",
      source: "reddit_official",
      networkAccess: false,
      message: "Reddit Official API provider is not implemented yet — serving demo data.",
      updatedAt: new Date().toISOString(),
    };
  }

  async getSubredditPulse(_params: {
    timeframe: PulseTimeframe;
    q?: string;
    subreddits?: string[];
  }): Promise<SubredditPulseResponse> {
    throw new Error("Reddit Official API provider not implemented");
  }

  async getTickerSocialFeed(_params: {
    ticker: string;
    timeframe: PulseTimeframe;
    q?: string;
    type?: SocialContentType | "all";
    sentiment?: SocialSentiment | "all";
    subreddit?: string | "all";
    sort?: SocialFeedSort;
  }): Promise<TickerSocialFeedResponse> {
    throw new Error("Reddit Official API provider not implemented");
  }
}

export const redditOfficialSocialDataProvider = new RedditOfficialSocialDataProviderStub();
