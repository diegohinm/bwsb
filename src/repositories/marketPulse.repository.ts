import { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import type { PulseTimeframe } from "../services/social/socialData.types.js";

/**
 * Market Pulse storage — the handoff between the worker and the API.
 *
 *   WORKER reads:  countStanceMentionGroups  (stored Reddit content)
 *   WORKER writes: saveMarketPulseSnapshot
 *   API reads:     readLatestMarketPulse
 *
 * The count runs in SQL rather than through `readSocialItems`, because that
 * reader caps each table at 2,000 rows and normalizes a missing stance to
 * "neutral". A capped count would make the score depend on how busy the window
 * was, and a defaulted stance would report an opinion nobody expressed — the
 * aggregate must see every row, exactly as stored.
 */

/**
 * One group of mentions sharing (provider, kind, stance), AS STORED. A mention
 * is one (item, distinct ticker) pair from the item's sanitized `tickers[]` —
 * the same display projection of the ticker associations that the strip,
 * the ticker pages and the Pulse page count.
 */
export interface MentionGroup {
  provider: string | null;
  kind: "post" | "comment";
  stance: string | null;
  mentions: number;
  items: number;
  tickers: string[];
  subreddits: string[];
  newest: string | null;
}

type GroupRow = {
  provider: string | null;
  kind: string;
  stance: string | null;
  mentions: number;
  items: number;
  tickers: string[] | null;
  subreddits: string[] | null;
  newest: Date | null;
};

/** Stance mention groups for content POSTED in [since, until). */
export async function countStanceMentionGroups(params: {
  since: Date;
  until: Date;
}): Promise<MentionGroup[]> {
  const { since, until } = params;

  // `cardinality(tickers) > 0` keeps the lateral unnest to ticker-bearing rows;
  // the posted_at range is served by the posted_at indexes on both tables.
  // DISTINCT in `mentions` collapses a symbol repeated in one item's array, so
  // the unit is always one item × one ticker.
  const rows = await prisma.$queryRaw<GroupRow[]>(Prisma.sql`
    WITH items AS (
      SELECT p.id, 'post'::text AS kind, p.provider, p.subreddit, p.stance,
             p.tickers, p.posted_at
        FROM social_posts p
       WHERE p.posted_at >= ${since} AND p.posted_at < ${until}
         AND cardinality(p.tickers) > 0
      UNION ALL
      SELECT c.id, 'comment'::text AS kind, c.provider, c.subreddit, c.stance,
             c.tickers, c.posted_at
        FROM social_comments c
       WHERE c.posted_at >= ${since} AND c.posted_at < ${until}
         AND cardinality(c.tickers) > 0
    ),
    mentions AS (
      SELECT DISTINCT i.id, i.kind, i.provider, i.subreddit, i.stance, i.posted_at,
             upper(t.ticker) AS ticker
        FROM items i
        CROSS JOIN LATERAL unnest(i.tickers) AS t(ticker)
       WHERE t.ticker IS NOT NULL AND t.ticker <> ''
    )
    SELECT provider,
           kind,
           stance,
           count(*)::int                                            AS mentions,
           count(DISTINCT id)::int                                  AS items,
           array_agg(DISTINCT ticker)                               AS tickers,
           array_agg(DISTINCT subreddit) FILTER (WHERE subreddit IS NOT NULL) AS subreddits,
           max(posted_at)                                           AS newest
      FROM mentions
     GROUP BY provider, kind, stance`);

  return rows.map((r) => ({
    provider: r.provider,
    kind: r.kind === "comment" ? "comment" : "post",
    stance: r.stance,
    mentions: Number(r.mentions),
    items: Number(r.items),
    tickers: r.tickers ?? [],
    subreddits: r.subreddits ?? [],
    newest: r.newest ? new Date(r.newest).toISOString() : null,
  }));
}

export interface MarketPulseSnapshotInput {
  timeframe: PulseTimeframe;
  windowStart: string;
  windowEnd: string;
  score: number | null;
  bullishCount: number;
  neutralCount: number;
  bearishCount: number;
  unclassifiedCount: number;
  mentionCount: number;
  itemCount: number;
  postCount: number;
  commentCount: number;
  tickerCount: number;
  subreddits: string[];
  provider: string | null;
  excludedItemCount: number;
  minClassifiedMentions: number;
  formulaVersion: string;
  latestMentionAt: string | null;
}

/** Append one snapshot. History is kept; the API reads only the newest. */
export async function saveMarketPulseSnapshot(
  input: MarketPulseSnapshotInput,
  snapshotAt: string,
): Promise<void> {
  await prisma.marketPulseSnapshots.create({
    data: {
      ...input,
      windowStart: new Date(input.windowStart),
      windowEnd: new Date(input.windowEnd),
      latestMentionAt: input.latestMentionAt ? new Date(input.latestMentionAt) : null,
      snapshotAt: new Date(snapshotAt),
    },
  });
}

/** A stored snapshot, as stored — the reader decides what it may claim. */
export interface StoredMarketPulse {
  timeframe: PulseTimeframe;
  windowStart: string;
  windowEnd: string;
  score: number | null;
  bullishCount: number;
  neutralCount: number;
  bearishCount: number;
  unclassifiedCount: number;
  mentionCount: number;
  itemCount: number;
  postCount: number;
  commentCount: number;
  tickerCount: number;
  subreddits: string[];
  provider: string | null;
  excludedItemCount: number;
  minClassifiedMentions: number;
  formulaVersion: string;
  latestMentionAt: string | null;
  snapshotAt: string;
}

/** The newest Market Pulse snapshot for a timeframe, or null if none exists. */
export async function readLatestMarketPulse(
  timeframe: PulseTimeframe,
): Promise<StoredMarketPulse | null> {
  const r = await prisma.marketPulseSnapshots.findFirst({
    where: { timeframe },
    orderBy: { snapshotAt: "desc" },
  });
  if (!r) return null;

  return {
    timeframe: r.timeframe as PulseTimeframe,
    windowStart: r.windowStart.toISOString(),
    windowEnd: r.windowEnd.toISOString(),
    score: r.score,
    bullishCount: r.bullishCount,
    neutralCount: r.neutralCount,
    bearishCount: r.bearishCount,
    unclassifiedCount: r.unclassifiedCount,
    mentionCount: r.mentionCount,
    itemCount: r.itemCount,
    postCount: r.postCount,
    commentCount: r.commentCount,
    tickerCount: r.tickerCount,
    subreddits: r.subreddits,
    provider: r.provider,
    excludedItemCount: r.excludedItemCount,
    minClassifiedMentions: r.minClassifiedMentions,
    formulaVersion: r.formulaVersion,
    latestMentionAt: r.latestMentionAt ? r.latestMentionAt.toISOString() : null,
    snapshotAt: r.snapshotAt.toISOString(),
  };
}
