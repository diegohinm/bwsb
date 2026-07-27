import { buildMockItems } from "./mockItems.js";
import {
  assemblePulseResponse,
  assembleTickerFeed,
  type ResponseMeta,
} from "../socialData.assemble.js";
import type { SocialDataProvider, SocialItemsResult } from "../socialData.provider.js";
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
 * DEMO provider. Serves centralized local fixtures — no network, no scraping.
 * Always available, so it doubles as the fallback whenever a configured
 * third-party provider is missing credentials or fails.
 */
export class MockSocialDataProvider implements SocialDataProvider {
  readonly name = "mock" as const;

  async getStatus(): Promise<SocialProviderStatus> {
    return {
      provider: "mock",
      status: "mock",
      source: "mock",
      networkAccess: false,
      message: "Serving centralized demo data. No provider network calls.",
      updatedAt: new Date().toISOString(),
    };
  }

  async getSubredditPulse(params: {
    timeframe: PulseTimeframe;
    q?: string;
    subreddits?: string[];
  }): Promise<SubredditPulseResponse> {
    const items = buildMockItems(params.timeframe);
    return assemblePulseResponse(items, params.timeframe, params.q, this.meta());
  }

  async getTickerSocialFeed(params: {
    ticker: string;
    timeframe: PulseTimeframe;
    q?: string;
    type?: SocialContentType | "all";
    sentiment?: SocialSentiment | "all";
    subreddit?: string | "all";
    sort?: SocialFeedSort;
  }): Promise<TickerSocialFeedResponse> {
    const items = buildMockItems(params.timeframe);
    return assembleTickerFeed(items, params, this.meta());
  }

  /** Demo items for the ingestion worker — no network, nothing can fail. */
  async fetchItems(params: {
    subreddits?: string[];
    timeframe?: PulseTimeframe;
  }): Promise<SocialItemsResult> {
    const items = buildMockItems(params.timeframe ?? "24h");
    const scoped = params.subreddits?.length
      ? items.filter((i) => params.subreddits!.includes(i.subreddit))
      : items;
    return {
      items: scoped,
      failed: [],
      rateLimited: false,
      attempted: params.subreddits?.length ?? 0,
    };
  }

  private meta(warning?: string): ResponseMeta {
    return {
      provider: "mock",
      source: "mock",
      isMock: true,
      updatedAt: new Date().toISOString(),
      ...(warning ? { warning } : {}),
    };
  }
}

export const mockSocialDataProvider = new MockSocialDataProvider();
