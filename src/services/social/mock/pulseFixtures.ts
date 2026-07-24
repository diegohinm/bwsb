import {
  TRACKED_SUBREDDITS,
  displayName,
} from "../subreddits.js";
import type {
  DivergenceRow,
  EmergingTicker,
  HeatmapCell,
  PulseSnapshot,
  PulseTimeframe,
  SubredditPulse,
} from "../types.js";

/**
 * DEMO DATA — centralized Reddit-like fixtures for the Pulse page.
 *
 * Everything here is synthetic. It is deterministic (seeded by subreddit /
 * ticker / timeframe) so the page does not flicker between reloads and so two
 * clients see the same snapshot. Any payload built from this module is flagged
 * `isDemo: true` and the UI must badge it as "Demo data".
 *
 * Replace by wiring a real SocialDataProvider — never by scraping Reddit.
 */

/** Deterministic 32-bit string hash (FNV-1a). */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable pseudo-random float in [0,1) for a seed string. */
function rand(seed: string): number {
  return hash(seed) / 0xffffffff;
}

/** Stable pseudo-random integer in [min,max]. */
function randInt(seed: string, min: number, max: number): number {
  return min + Math.floor(rand(seed) * (max - min + 1));
}

/** Round to one decimal place. */
function r1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** How much volume a timeframe carries relative to a 1h window. */
const TIMEFRAME_VOLUME: Record<PulseTimeframe, number> = {
  "1h": 1,
  "6h": 5.2,
  "24h": 18,
  "7d": 104,
};

const TIMEFRAME_LABEL: Record<PulseTimeframe, string> = {
  "1h": "the last hour",
  "6h": "the last 6 hours",
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
};

/** Ticker universe used by the fixtures. */
const TICKERS: ReadonlyArray<{ ticker: string; company: string }> = [
  { ticker: "NVDA", company: "NVIDIA Corp." },
  { ticker: "TSLA", company: "Tesla Inc." },
  { ticker: "GME", company: "GameStop Corp." },
  { ticker: "AMC", company: "AMC Entertainment" },
  { ticker: "PLTR", company: "Palantir Technologies" },
  { ticker: "SPY", company: "SPDR S&P 500 ETF" },
  { ticker: "AMD", company: "Advanced Micro Devices" },
  { ticker: "HOOD", company: "Robinhood Markets" },
  { ticker: "RDDT", company: "Reddit Inc." },
  { ticker: "SOFI", company: "SoFi Technologies" },
  { ticker: "BBAI", company: "BigBear.ai Holdings" },
  { ticker: "MSTR", company: "MicroStrategy Inc." },
  { ticker: "INTC", company: "Intel Corp." },
  { ticker: "BRK.B", company: "Berkshire Hathaway" },
  { ticker: "MU", company: "Micron Technology" },
];

/** Tickers each community realistically talks about, so the mock reads true. */
const SUBREDDIT_TICKER_BIAS: Record<string, string[]> = {
  wallstreetbets: ["NVDA", "TSLA", "GME", "PLTR", "SPY", "MSTR"],
  stocks: ["NVDA", "AMD", "INTC", "MU", "TSLA", "RDDT"],
  investing: ["SPY", "BRK.B", "NVDA", "INTC", "MU"],
  options: ["SPY", "NVDA", "TSLA", "AMD", "HOOD"],
  pennystocks: ["BBAI", "SOFI", "AMC", "HOOD"],
  Shortsqueeze: ["GME", "AMC", "BBAI", "MSTR", "SOFI"],
  ValueInvesting: ["BRK.B", "INTC", "MU", "SOFI"],
  SecurityAnalysis: ["BRK.B", "INTC", "RDDT", "MU", "PLTR"],
};

function companyOf(ticker: string): string {
  return TICKERS.find((t) => t.ticker === ticker)?.company ?? ticker;
}

function pulseLabel(score: number): { label: string; description: string } {
  if (score >= 75)
    return {
      label: "Euphoric",
      description:
        "Retail chatter is running hot. Call flow and momentum names dominate the feed.",
    };
  if (score >= 60)
    return {
      label: "Bullish Pulse",
      description:
        "Sentiment is strong. Traders are loading calls and momentum plays.",
    };
  if (score >= 45)
    return {
      label: "Mixed Pulse",
      description:
        "Communities disagree. Bullish and bearish flow are close to balanced.",
    };
  if (score >= 30)
    return {
      label: "Cautious",
      description:
        "Chatter is cooling. Hedges and profit-taking posts are gaining share.",
    };
  return {
    label: "Bearish Pulse",
    description:
      "Risk-off tone across the tracked communities. Puts and bag-holding posts lead.",
  };
}

function buildSubreddits(timeframe: PulseTimeframe): SubredditPulse[] {
  const volume = TIMEFRAME_VOLUME[timeframe];

  return TRACKED_SUBREDDITS.map((sub) => {
    const seed = `${sub.name}:${timeframe}`;
    const basePosts = randInt(`posts:${seed}`, 8, 60);
    const posts = Math.round(basePosts * volume);
    const comments = Math.round(
      posts * (3 + rand(`cratio:${seed}`) * 9),
    );

    // Retail chatter skews bullish, so the split does too.
    const bullish = randInt(`bull:${seed}`, 30, 70);
    const bearish = randInt(`bear:${seed}`, 10, Math.min(38, Math.max(11, 95 - bullish)));
    const neutral = Math.max(0, 100 - bullish - bearish);

    const bias = SUBREDDIT_TICKER_BIAS[sub.name] ?? [];
    const topTickers = [...bias]
      .sort((a, b) => rand(`rank:${a}:${seed}`) - rand(`rank:${b}:${seed}`))
      .slice(0, 4);

    return {
      subreddit: sub.name,
      displayName: displayName(sub.name),
      posts,
      comments,
      activityScore: randInt(`act:${seed}`, 22, 98),
      momentumPct: r1(rand(`mom:${seed}`) * 160 - 55),
      sentiment: { bullish, neutral, bearish },
      topTickers,
    };
  }).sort((a, b) => b.activityScore - a.activityScore);
}

function buildEmergingTickers(
  timeframe: PulseTimeframe,
  subreddits: SubredditPulse[],
): EmergingTicker[] {
  const volume = TIMEFRAME_VOLUME[timeframe];

  return TICKERS.map(({ ticker }) => {
    const seed = `${ticker}:${timeframe}`;
    const sentimentScore = Math.round(rand(`sent:${seed}`) * 200 - 100);
    const origin =
      subreddits.find((s) => s.topTickers.includes(ticker))?.subreddit ??
      subreddits[0]?.subreddit ??
      "wallstreetbets";

    return {
      ticker,
      company: companyOf(ticker),
      mentions: Math.round(randInt(`men:${seed}`, 6, 140) * volume),
      mentionsDeltaPct: r1(rand(`delta:${seed}`) * 340 - 40),
      originSubreddit: origin,
      sentimentScore,
      stance:
        sentimentScore > 20
          ? "bullish"
          : sentimentScore < -20
            ? "bearish"
            : "neutral",
    } satisfies EmergingTicker;
  })
    .sort((a, b) => b.mentionsDeltaPct - a.mentionsDeltaPct)
    .slice(0, 8);
}

function buildDivergence(
  timeframe: PulseTimeframe,
  subreddits: SubredditPulse[],
): DivergenceRow[] {
  const rows: DivergenceRow[] = [];

  for (const { ticker } of TICKERS) {
    // Communities that actually discuss this ticker.
    const holders = subreddits.filter((s) => s.topTickers.includes(ticker));
    if (holders.length < 2) continue;

    const scored = holders
      .map((s) => ({
        subreddit: s.subreddit,
        score: Math.round(rand(`div:${ticker}:${s.subreddit}:${timeframe}`) * 100),
      }))
      .sort((a, b) => b.score - a.score);

    const top = scored[0];
    const bottom = scored[scored.length - 1];
    const spread = top.score - bottom.score;
    if (spread < 25) continue;

    rows.push({
      ticker,
      bullishSubreddit: top.subreddit,
      bullishScore: top.score,
      bearishSubreddit: bottom.subreddit,
      bearishScore: bottom.score,
      spread,
    });
  }

  return rows.sort((a, b) => b.spread - a.spread).slice(0, 6);
}

function buildHeatmap(
  timeframe: PulseTimeframe,
  subreddits: SubredditPulse[],
  emerging: EmergingTicker[],
): PulseSnapshot["heatmap"] {
  const tickers = emerging.slice(0, 6).map((t) => t.ticker);
  const subs = subreddits.map((s) => s.subreddit);
  const cells: HeatmapCell[] = [];

  for (const ticker of tickers) {
    for (const subreddit of subs) {
      const discussed = (SUBREDDIT_TICKER_BIAS[subreddit] ?? []).includes(ticker);
      const seed = `heat:${ticker}:${subreddit}:${timeframe}`;
      // Communities that don't cover a name still show faint background chatter.
      const intensity = discussed
        ? randInt(seed, 45, 100)
        : randInt(seed, 0, 32);
      cells.push({ ticker, subreddit, intensity });
    }
  }

  return { tickers, subreddits: subs, cells };
}

/** Build the full demo snapshot for a timeframe. */
export function buildMockPulseSnapshot(
  timeframe: PulseTimeframe,
  generatedAt: string,
): Omit<PulseSnapshot, "source" | "isDemo" | "fallbackReason"> {
  const subreddits = buildSubreddits(timeframe);
  const emergingTickers = buildEmergingTickers(timeframe, subreddits);
  const divergence = buildDivergence(timeframe, subreddits);
  const heatmap = buildHeatmap(timeframe, subreddits, emergingTickers);

  const postsAnalyzed = subreddits.reduce((sum, s) => sum + s.posts, 0);
  const commentsAnalyzed = subreddits.reduce((sum, s) => sum + s.comments, 0);

  // Weight each community's sentiment by how active it is.
  const totalActivity = subreddits.reduce((sum, s) => sum + s.activityScore, 0);
  const bullishShare = r1(
    subreddits.reduce((sum, s) => sum + s.sentiment.bullish * s.activityScore, 0) /
      Math.max(1, totalActivity),
  );
  const bearishShare = r1(
    subreddits.reduce((sum, s) => sum + s.sentiment.bearish * s.activityScore, 0) /
      Math.max(1, totalActivity),
  );

  // 50 = balanced; push toward whichever side dominates.
  const score = Math.max(
    0,
    Math.min(100, Math.round(50 + (bullishShare - bearishShare) * 0.8)),
  );
  const { label, description } = pulseLabel(score);

  return {
    timeframe,
    generatedAt,
    overall: {
      score,
      label,
      description: `${description} Based on ${TIMEFRAME_LABEL[timeframe]}.`,
      postsAnalyzed,
      commentsAnalyzed,
      bullishShare,
      bearishShare,
    },
    subreddits,
    emergingTickers,
    divergence,
    heatmap,
  };
}
