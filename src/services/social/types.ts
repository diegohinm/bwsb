/**
 * Shared contract for Reddit-like social data.
 *
 * The app never scrapes Reddit. Every implementation of `SocialDataProvider` is
 * either local fixture/mock data or a third-party aggregator queried from the
 * backend only (API keys stay server-side). Providers are interchangeable — a
 * page must never assume a specific one.
 */

export const PULSE_TIMEFRAMES = ["1h", "6h", "24h", "7d"] as const;
export type PulseTimeframe = (typeof PULSE_TIMEFRAMES)[number];

export function isPulseTimeframe(value: unknown): value is PulseTimeframe {
  return (
    typeof value === "string" &&
    (PULSE_TIMEFRAMES as readonly string[]).includes(value)
  );
}

/** Which upstream produced a payload. Always echoed back to the client. */
export type SocialSourceName =
  | "mock"
  | "mindcase"
  | "brandwatch"
  | "reddit_official";

export type SentimentSplit = {
  bullish: number;
  neutral: number;
  bearish: number;
};

export type SubredditPulse = {
  /** Canonical name without the `r/` prefix. */
  subreddit: string;
  /** Display form, e.g. `r/wallstreetbets`. */
  displayName: string;
  /** Posts seen in the timeframe. */
  posts: number;
  /** Comments seen in the timeframe. */
  comments: number;
  /** 0-100 relative activity. */
  activityScore: number;
  /** Percentage change in activity vs the previous equivalent window. */
  momentumPct: number;
  sentiment: SentimentSplit;
  /** Most discussed tickers inside this subreddit. */
  topTickers: string[];
};

export type EmergingTicker = {
  ticker: string;
  company: string;
  mentions: number;
  /** Percentage change in mentions vs the previous equivalent window. */
  mentionsDeltaPct: number;
  /** Subreddit where the surge started. */
  originSubreddit: string;
  /** -100..100 — negative is bearish. */
  sentimentScore: number;
  stance: "bullish" | "bearish" | "neutral";
};

export type DivergenceRow = {
  ticker: string;
  bullishSubreddit: string;
  bullishScore: number;
  bearishSubreddit: string;
  bearishScore: number;
  /** Absolute gap between the two communities. */
  spread: number;
};

export type HeatmapCell = {
  ticker: string;
  subreddit: string;
  /** 0-100 mention intensity. */
  intensity: number;
};

export type PulseOverall = {
  /** 0-100 aggregate pulse across every tracked subreddit. */
  score: number;
  label: string;
  description: string;
  postsAnalyzed: number;
  commentsAnalyzed: number;
  bullishShare: number;
  bearishShare: number;
};

export type PulseSnapshot = {
  timeframe: PulseTimeframe;
  /** ISO timestamp of when the snapshot was produced. */
  generatedAt: string;
  /** Provider that actually produced the data. */
  source: SocialSourceName;
  /** True when the data is fixture/demo data and must be badged in the UI. */
  isDemo: boolean;
  /** Set when the configured provider was unavailable and mock was used. */
  fallbackReason: string | null;
  overall: PulseOverall;
  subreddits: SubredditPulse[];
  emergingTickers: EmergingTicker[];
  divergence: DivergenceRow[];
  heatmap: {
    tickers: string[];
    subreddits: string[];
    cells: HeatmapCell[];
  };
};

export type PulseQuery = {
  timeframe: PulseTimeframe;
};

export interface SocialDataProvider {
  readonly name: SocialSourceName;
  /** True when the provider has everything it needs to serve real data. */
  readonly isEnabled: boolean;
  getPulse(query: PulseQuery): Promise<PulseSnapshot>;
}
