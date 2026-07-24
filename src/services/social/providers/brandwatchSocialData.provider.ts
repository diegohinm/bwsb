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
 * FUTURE PROVIDER — Brandwatch (enterprise social listening). Not implemented.
 *
 * getStatus reports `misconfigured` so the service layer serves demo data. The
 * fetch methods throw; the service catches and falls back to mock. Implement the
 * real client here (backend-only credentials) when the integration lands.
 */
export class BrandwatchSocialDataProviderStub implements SocialDataProvider {
  readonly name = "brandwatch" as const;

  async getStatus(): Promise<SocialProviderStatus> {
    return {
      provider: "brandwatch",
      status: "misconfigured",
      source: "brandwatch",
      networkAccess: false,
      message: "Brandwatch provider is not implemented yet — serving demo data.",
      updatedAt: new Date().toISOString(),
    };
  }

  async getSubredditPulse(_params: {
    timeframe: PulseTimeframe;
    q?: string;
    subreddits?: string[];
  }): Promise<SubredditPulseResponse> {
    throw new Error("Brandwatch provider not implemented");
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
    throw new Error("Brandwatch provider not implemented");
  }
}

export const brandwatchSocialDataProvider = new BrandwatchSocialDataProviderStub();
