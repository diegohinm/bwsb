import { prisma } from "../lib/prisma.js";
import { toDbRows } from "../lib/rows.js";
import type { TickerMention } from "../types/domain.js";

/**
 * Data access for ticker mentions and stance events.
 *
 * Rows are returned with their database column names (see lib/rows.ts) because
 * the ticker/trends routes serialize them straight onto the wire.
 */

const MENTION_COLUMNS = {
  id: true,
  ticker: true,
  redditPostId: true,
  pumpLanguageScore: true,
  narrativeType: true,
  createdAt: true,
} as const;

export const mentionsRepository = {
  async forTicker(ticker: string, limit = 100): Promise<TickerMention[]> {
    const rows = await prisma.tickerMentions.findMany({
      where: { ticker },
      select: MENTION_COLUMNS,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return toDbRows<TickerMention>("TickerMentions", rows);
  },

  /** Mentions joined to the post they came from (the JOIN is an inner one). */
  async withPostForTicker(ticker: string, limit = 100) {
    const rows = await prisma.tickerMentions.findMany({
      where: { ticker },
      select: {
        ...MENTION_COLUMNS,
        redditPosts: {
          select: {
            title: true,
            subreddit: true,
            score: true,
            numComments: true,
            permalink: true,
            redditCreatedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return rows.map(({ redditPosts, ...mention }) => ({
      ...toDbRows<Record<string, unknown>>("TickerMentions", [mention])[0],
      ...toDbRows<Record<string, unknown>>("RedditPosts", [redditPosts])[0],
    }));
  },

  async stanceForTicker(ticker: string) {
    const rows = await prisma.tickerStanceEvents.findMany({
      where: { ticker },
      select: {
        ticker: true,
        subreddit: true,
        stance: true,
        confidence: true,
        matchedTerms: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return toDbRows("TickerStanceEvents", rows);
  },

  /**
   * Stance counts for a ticker, optionally limited to events since `sinceIso`.
   *
   * The window is what makes the workspace's 1H/6H/24H/7D selector mean
   * something here: without it the split is all-time and would not move when the
   * user narrows the period. Served by the `stance_events_created_idx` index.
   */
  async stanceSplit(
    ticker: string,
    sinceIso?: string,
  ): Promise<{ stance: string; n: number }[]> {
    const groups = await prisma.tickerStanceEvents.groupBy({
      by: ["stance"],
      where: {
        ticker,
        ...(sinceIso ? { createdAt: { gte: new Date(sinceIso) } } : {}),
      },
      _count: { _all: true },
    });
    return groups.map((g) => ({ stance: g.stance, n: g._count._all }));
  },

  /** Divergence of stance across subreddits for a ticker. */
  async stanceBySubreddit(ticker: string) {
    // `count(*) FILTER (WHERE stance = …)` has no Prisma equivalent, so group by
    // both columns and pivot stance into one row per subreddit here.
    const groups = await prisma.tickerStanceEvents.groupBy({
      by: ["subreddit", "stance"],
      where: { ticker },
      _count: { _all: true },
    });

    const bySubreddit = new Map<
      string | null,
      { subreddit: string | null; bullish: number; bearish: number; neutral: number }
    >();

    for (const g of groups) {
      const row =
        bySubreddit.get(g.subreddit) ??
        { subreddit: g.subreddit, bullish: 0, bearish: 0, neutral: 0 };
      if (g.stance === "bullish") row.bullish += g._count._all;
      else if (g.stance === "bearish") row.bearish += g._count._all;
      else if (g.stance === "neutral") row.neutral += g._count._all;
      bySubreddit.set(g.subreddit, row);
    }

    return [...bySubreddit.values()];
  },
};
