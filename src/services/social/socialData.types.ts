/**
 * Shared contract for Reddit-like social data.
 *
 * The app NEVER scrapes Reddit. Every implementation of `SocialDataProvider` is
 * either local fixture/mock data or a third-party aggregator queried from the
 * backend only (API keys stay server-side). Providers are interchangeable — a
 * page must never assume a specific one, and the response always echoes which
 * provider/source produced it so the UI can badge demo vs. live data.
 */

export const PULSE_TIMEFRAMES = ["1h", "6h", "24h", "7d"] as const;
export type PulseTimeframe = (typeof PULSE_TIMEFRAMES)[number];

export function isPulseTimeframe(value: unknown): value is PulseTimeframe {
  return (
    typeof value === "string" &&
    (PULSE_TIMEFRAMES as readonly string[]).includes(value)
  );
}

export type SocialDataProviderName =
  | "mock"
  | "mindcase"
  | "brandwatch"
  | "reddit_official";

export type SocialContentType =
  | "post"
  | "comment"
  | "screenshot"
  | "link"
  | "unknown";

export type SocialSentiment = "positive" | "neutral" | "negative";

export type SocialStance = "bullish" | "bearish" | "neutral";

/** Sort orders for the ticker social feed. */
export type SocialFeedSort =
  | "newest"
  | "top"
  | "most_comments"
  | "highest_confidence";

export interface SocialProviderStatus {
  provider: SocialDataProviderName;
  /**
   *  ready        → configured provider is serving live data
   *  mock         → the mock provider is intentionally selected
   *  misconfigured→ a real provider is selected but missing credentials
   *  error        → the provider errored and mock is being served as fallback
   */
  status: "ready" | "mock" | "misconfigured" | "error";
  source: string;
  networkAccess: boolean;
  message?: string;
  updatedAt: string;
}

export interface SocialPostItem {
  id: string;
  provider: SocialDataProviderName;
  source: string;
  subreddit: string;
  type: SocialContentType;
  title?: string;
  text?: string;
  url?: string;
  /** Anonymized author reference — never a raw Reddit username. */
  authorHash?: string;
  score?: number;
  numComments?: number;
  createdAt: string;
  tickers: string[];
  sentiment: SocialSentiment;
  stance: SocialStance;
  confidence: number;
  isScreenshot: boolean;
}

export type SentimentSplit = {
  bullish: number;
  neutral: number;
  bearish: number;
};

export interface SubredditPulseMetric {
  /** Display form, e.g. `r/wallstreetbets`. */
  subreddit: string;
  activityScore: number;
  mentions: number;
  changePct: number;
  mood: string;
  topTickers: string[];
  sentiment: SocialSentiment;
  stance: SocialStance;
  /** Bullish/neutral/bearish share (0-100) used by the segment meters. */
  sentimentSplit: SentimentSplit;
  /** One-line human explanation of the mood. */
  explanation: string;
  recentPosts: SocialPostItem[];
  recentComments: SocialPostItem[];
}

export interface EmergingTickerMetric {
  ticker: string;
  firstDetectedSubreddit: string;
  spreadCount: number;
  accelerationScore: number;
  status: "early" | "heating" | "crowded";
}

export interface CommunityDivergenceMetric {
  ticker: string;
  summary: string;
  communities: {
    subreddit: string;
    stance: SocialStance;
    sentiment: SocialSentiment;
  }[];
}

/**
 * A single ticker ranked by how much Reddit is talking about it, with the
 * dominant crowd stance. Aggregated across every tracked community, so it is the
 * canonical "top mentioned across Reddit investing communities" list that feeds
 * the dashboard ticker strip. Provider-agnostic — computed from the same
 * normalized items every provider produces.
 */
export interface TopMentionedTicker {
  symbol: string;
  mentionCount: number;
  stance: SocialStance;
}

export interface PulseHeatmap {
  tickers: string[];
  subreddits: string[];
  /** rows = tickers, cols = subreddits, value 0..100 = mention intensity. */
  cells: number[][];
}

export interface SubredditPulseResponse {
  timeframe: PulseTimeframe;
  provider: SocialDataProviderName;
  source: string;
  isMock: boolean;
  updatedAt: string;
  warning?: string;
  overall: {
    score: number;
    label: string;
    description: string;
    changePct: number;
  };
  subreddits: SubredditPulseMetric[];
  emergingTickers: EmergingTickerMetric[];
  divergence: CommunityDivergenceMetric[];
  heatmap: PulseHeatmap;
  /** Top tickers by raw mention volume across all communities (desc). */
  topMentioned: TopMentionedTicker[];
}

export interface TickerSocialFeedResponse {
  ticker: string;
  provider: SocialDataProviderName;
  source: string;
  isMock: boolean;
  updatedAt: string;
  warning?: string;
  items: SocialPostItem[];
}
