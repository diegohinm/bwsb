import { prisma } from "../../lib/prisma.js";
import { TRACKED_SUBREDDIT_NAMES } from "../social/subreddits.js";
import {
  DEFAULT_TRENDING_LIMIT,
  SOCIAL_TIMEFRAME_MS,
  type SocialTimeframe,
} from "./calendarVocabulary.js";

/**
 * WHICH TICKERS THE PUBLIC CALENDAR IS ABOUT.
 *
 * Nothing here is a fixed list. The symbols are whatever the tracked investing
 * communities have actually been talking about in the selected window, ranked
 * by mention count — so the calendar follows Reddit rather than an editor's
 * opinion, and changes on its own as attention moves.
 *
 * It reads stored `social_posts` / `social_comments` only. Changing the
 * timeframe or the subreddit selection re-aggregates in Postgres; it never
 * reaches the social provider.
 */

export type TrendingTicker = {
  symbol: string;
  rank: number;
  mentions: number;
  subredditCount: number;
  sentiment: {
    bullishPct: number;
    neutralPct: number;
    bearishPct: number;
    dominant: "bullish" | "neutral" | "bearish" | null;
    classifiedCount: number;
  } | null;
};

export type TrendingResult = {
  tickers: TrendingTicker[];
  /** Mentions across every symbol in the window, not just the returned ones. */
  totalMentions: number;
  /** Null when the window held no content at all. */
  sourceSocial: string | null;
  windowStart: Date;
};

type Item = {
  subreddit: string | null;
  stance: string | null;
  tickers: string[];
};

type Agg = {
  symbol: string;
  mentions: number;
  bullish: number;
  neutral: number;
  bearish: number;
  subreddits: Set<string>;
};

const share = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

function dominantOf(a: Agg): "bullish" | "neutral" | "bearish" | null {
  const classified = a.bullish + a.neutral + a.bearish;
  if (classified === 0) return null;
  if (a.bullish >= a.neutral && a.bullish >= a.bearish) return "bullish";
  if (a.bearish >= a.neutral) return "bearish";
  return "neutral";
}

/**
 * Rank the most-mentioned symbols in a social window.
 *
 * One mention per content item per symbol: a post that says NVDA five times is
 * one person talking about NVDA once, and letting repetition inflate the count
 * would put whoever writes longest at the top of the calendar.
 */
export async function rankTrendingTickers(options: {
  timeframe: SocialTimeframe;
  subreddits?: readonly string[];
  limit?: number;
  now?: Date;
}): Promise<TrendingResult> {
  const {
    timeframe,
    subreddits = TRACKED_SUBREDDIT_NAMES,
    limit = DEFAULT_TRENDING_LIMIT,
    now = new Date(),
  } = options;

  const windowStart = new Date(now.getTime() - SOCIAL_TIMEFRAME_MS[timeframe]);
  const where = {
    postedAt: { gte: windowStart },
    subreddit: { in: [...subreddits] },
  };
  const select = { subreddit: true, stance: true, tickers: true } as const;

  const [posts, comments] = await Promise.all([
    prisma.socialPosts.findMany({ where, select }),
    prisma.socialComments.findMany({ where, select }),
  ]);

  const items: Item[] = [...posts, ...comments].map((i) => ({
    subreddit: i.subreddit,
    stance: i.stance,
    tickers: i.tickers ?? [],
  }));

  const bySymbol = new Map<string, Agg>();
  let totalMentions = 0;

  for (const item of items) {
    for (const raw of new Set(item.tickers)) {
      const symbol = raw.toUpperCase();
      let agg = bySymbol.get(symbol);
      if (!agg) {
        agg = {
          symbol,
          mentions: 0,
          bullish: 0,
          neutral: 0,
          bearish: 0,
          subreddits: new Set(),
        };
        bySymbol.set(symbol, agg);
      }
      agg.mentions += 1;
      totalMentions += 1;
      if (item.stance === "bullish") agg.bullish += 1;
      else if (item.stance === "bearish") agg.bearish += 1;
      else if (item.stance === "neutral") agg.neutral += 1;
      if (item.subreddit) agg.subreddits.add(item.subreddit);
    }
  }

  const ranked = [...bySymbol.values()]
    .sort(
      (a, b) =>
        b.mentions - a.mentions ||
        b.subreddits.size - a.subreddits.size ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, limit)
    .map((agg, index): TrendingTicker => {
      const classified = agg.bullish + agg.neutral + agg.bearish;
      return {
        symbol: agg.symbol,
        rank: index + 1,
        mentions: agg.mentions,
        subredditCount: agg.subreddits.size,
        // Percentages are of CLASSIFIED items. An item whose stance was never
        // read is not evidence of neutrality, so it is excluded rather than
        // counted as neutral.
        sentiment:
          classified === 0
            ? null
            : {
                bullishPct: share(agg.bullish, classified),
                neutralPct: share(agg.neutral, classified),
                bearishPct: share(agg.bearish, classified),
                dominant: dominantOf(agg),
                classifiedCount: classified,
              },
      };
    });

  return {
    tickers: ranked,
    totalMentions,
    sourceSocial: items.length > 0 ? "mindcase" : null,
    windowStart,
  };
}
