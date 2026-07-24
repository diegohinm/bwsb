import { buildSubredditPulse } from "./pulseAggregator.service.js";
import { displayName } from "./subreddits.js";
import type {
  PulseTimeframe,
  SocialContentType,
  SocialDataProviderName,
  SocialFeedSort,
  SocialPostItem,
  SocialSentiment,
  SubredditPulseResponse,
  TickerSocialFeedResponse,
} from "./socialData.types.js";

/**
 * Shared assembly helpers. Every provider produces a flat `SocialPostItem[]`
 * and then uses these to build the two response envelopes — so pulse scoring,
 * search and feed filtering behave identically no matter which upstream (mock,
 * Mindcase, …) supplied the items.
 */

export interface ResponseMeta {
  provider: SocialDataProviderName;
  source: string;
  isMock: boolean;
  updatedAt: string;
  warning?: string;
}

/** Case-insensitive match of a query against a subreddit/ticker context. */
function matchesQuery(item: SocialPostItem, q: string): boolean {
  const hay = [
    item.subreddit,
    item.title ?? "",
    item.text ?? "",
    ...item.tickers,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export function assemblePulseResponse(
  items: SocialPostItem[],
  timeframe: PulseTimeframe,
  q: string | undefined,
  meta: ResponseMeta,
): SubredditPulseResponse {
  const query = (q ?? "").trim().toLowerCase();
  const scoped = query ? items.filter((i) => matchesQuery(i, query)) : items;
  const aggregate = buildSubredditPulse(scoped, timeframe);

  return {
    timeframe,
    provider: meta.provider,
    source: meta.source,
    isMock: meta.isMock,
    updatedAt: meta.updatedAt,
    ...(meta.warning ? { warning: meta.warning } : {}),
    ...aggregate,
  };
}

export function assembleTickerFeed(
  items: SocialPostItem[],
  params: {
    ticker: string;
    q?: string;
    type?: SocialContentType | "all";
    sentiment?: SocialSentiment | "all";
    subreddit?: string | "all";
    sort?: SocialFeedSort;
  },
  meta: ResponseMeta,
): TickerSocialFeedResponse {
  const ticker = params.ticker.toUpperCase();
  const query = (params.q ?? "").trim().toLowerCase();
  const wantSub =
    params.subreddit && params.subreddit !== "all"
      ? params.subreddit.replace(/^r\//i, "").toLowerCase()
      : null;

  let feed = items.filter((i) => i.tickers.includes(ticker));

  if (params.type && params.type !== "all") {
    feed = feed.filter((i) => i.type === params.type);
  }
  if (params.sentiment && params.sentiment !== "all") {
    feed = feed.filter((i) => i.sentiment === params.sentiment);
  }
  if (wantSub) {
    feed = feed.filter((i) => i.subreddit.toLowerCase() === wantSub);
  }
  if (query) {
    feed = feed.filter((i) => matchesQuery(i, query));
  }

  const sort = params.sort ?? "newest";
  feed = [...feed].sort((a, b) => {
    switch (sort) {
      case "top":
        return (b.score ?? 0) - (a.score ?? 0);
      case "most_comments":
        return (b.numComments ?? 0) - (a.numComments ?? 0);
      case "highest_confidence":
        return b.confidence - a.confidence;
      case "newest":
      default:
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    }
  });

  return {
    ticker,
    provider: meta.provider,
    source: meta.source,
    isMock: meta.isMock,
    updatedAt: meta.updatedAt,
    ...(meta.warning ? { warning: meta.warning } : {}),
    items: feed.slice(0, 200),
  };
}

/** Present a canonical subreddit name as `r/name` for filter dropdowns. */
export function subredditLabel(name: string): string {
  return displayName(name);
}
