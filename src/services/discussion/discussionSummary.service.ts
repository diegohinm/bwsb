import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { increment } from "../../lib/metrics.js";
import { DISPLAY_THRESHOLD } from "../extraction/tickerExtraction.service.js";
import { BUCKET_MINUTES, bucketStartFor } from "../social/tickerActivity.service.js";

/**
 * The Discussion summary — totals, sentiment split and ticker rankings for the
 * CURRENTLY SELECTED range.
 *
 * AGGREGATED IN POSTGRES, NOT IN THE BROWSER. The previous implementation
 * counted whatever rows the feed happened to have fetched, so "total
 * discussions" was really "rows on this page" and the ticker ranking was drawn
 * from at most 60 items. Those numbers were wrong in a way that looked right.
 *
 * Every figure here comes from a `GROUP BY` over the whole window.
 *
 * It is scoped by the WINDOW and the COMMUNITIES, and by nothing else. It once
 * took the feed's search, content type and sentiment as well; see `filterSql`
 * for why that made the card describe the visible page instead of the
 * conversation.
 */

export const DISCUSSION_RANGES = ["1h", "6h", "24h", "7d", "30d", "custom"] as const;
export type DiscussionRange = (typeof DISCUSSION_RANGES)[number];

export function isDiscussionRange(value: unknown): value is DiscussionRange {
  return typeof value === "string" && (DISCUSSION_RANGES as readonly string[]).includes(value);
}

const RANGE_HOURS: Record<Exclude<DiscussionRange, "custom">, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

const RANGE_LABELS: Record<Exclude<DiscussionRange, "custom">, string> = {
  "1h": "Last 1 hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/** How many tickers the ranking returns. The panel scrolls internally. */
export const TOP_TICKER_LIMIT = 30;

/**
 * Minimum mentions in the CURRENT window before a ticker may be called hot.
 *
 * Scaled by window length, because "five mentions" means something very
 * different in an hour than in a month. Without a floor, hotness degenerates
 * into a list of symbols that went from one mention to four.
 *
 * THE SHAPE IS FIXED; THE HEIGHT IS CONFIGURABLE. `HOT_TICKERS_MIN_MENTIONS`
 * sets the 24-hour floor and every other window is a fixed ratio of it, so
 * tuning one number moves the whole curve and cannot accidentally make an hour
 * stricter than a week. At the default of 5 this reproduces the hand-picked
 * 2/3/5/10/20 exactly — the knob was added without changing the behaviour it
 * describes.
 */
const FLOOR_RATIOS: readonly { maxHours: number; ratio: number }[] = [
  { maxHours: 1, ratio: 2 / 5 },
  { maxHours: 6, ratio: 3 / 5 },
  { maxHours: 24, ratio: 1 },
  { maxHours: 24 * 7, ratio: 2 },
  { maxHours: Infinity, ratio: 4 },
];

export function minimumHotMentions(hours: number): number {
  const base = env.HOT_TICKERS_MIN_MENTIONS;
  const { ratio } = FLOOR_RATIOS.find((r) => hours <= r.maxHours) ?? FLOOR_RATIOS.at(-1)!;
  // A base of 0 means "no floor at all", which stays 0 rather than rounding up
  // to 1 — an explicitly disabled guard must actually be disabled.
  return base === 0 ? 0 : Math.max(1, Math.round(base * ratio));
}

export type SummaryQuery = {
  range: DiscussionRange;
  /** Only for `range === "custom"`. Both required, `from < to`. */
  from?: Date;
  to?: Date;
  /** Empty or absent means every tracked community. */
  subreddits?: string[];
  /**
   * NO contentType / sentiment / search. The summary is an aggregate of the
   * conversation in a window, not a description of the rows the feed happens
   * to be showing. See `filterSql`.
   */
  /** Injectable so the window is deterministic in tests. */
  now?: Date;
};

export type ResolvedWindow = {
  from: Date;
  to: Date;
  /** The immediately preceding window of EQUAL duration. */
  previousFrom: Date;
  previousTo: Date;
  label: string;
  hours: number;
};

/**
 * Work out the current window and the one it is compared against.
 *
 * The comparison window is always the same DURATION as the current one and
 * immediately precedes it. Comparing a 3-day custom range against a fixed 24
 * hours would make growth a statement about window size rather than about
 * attention.
 */
export function resolveWindow(query: SummaryQuery): ResolvedWindow {
  const now = query.now ?? new Date();

  if (query.range === "custom" && query.from && query.to) {
    const from = query.from;
    const to = query.to;
    const durationMs = Math.max(1, to.getTime() - from.getTime());
    return {
      from,
      to,
      previousFrom: new Date(from.getTime() - durationMs),
      previousTo: from,
      label: formatCustomLabel(from, to),
      hours: durationMs / 3_600_000,
    };
  }

  const key = (query.range === "custom" ? "24h" : query.range) as Exclude<
    DiscussionRange,
    "custom"
  >;
  const hours = RANGE_HOURS[key];
  const durationMs = hours * 3_600_000;
  const from = new Date(now.getTime() - durationMs);

  return {
    from,
    to: now,
    previousFrom: new Date(now.getTime() - durationMs * 2),
    previousTo: from,
    label: RANGE_LABELS[key],
    hours,
  };
}

/** "Aug 1 – Aug 5, 2026" */
function formatCustomLabel(from: Date, to: Date): string {
  const md = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const year = to.getUTCFullYear();
  return `${md.format(from)} – ${md.format(to)}, ${year}`;
}

export type TickerRanking = {
  symbol: string;
  mentions: number;
  /** Share of all ticker mentions in the window, 0–100. */
  mentionShare: number;
  /**
   * The full split, so the panel can render the same three-segment bar the
   * Tickers table uses. Returning only the bullish share would force the client
   * to invent the other two, and a 23/52/25 split would become
   * indistinguishable from 23/0/77.
   *
   * Null across all three when nothing in the window was classified — which is
   * a different statement from "nobody was bullish".
   */
  bullishPercent: number | null;
  neutralPercent: number | null;
  bearishPercent: number | null;
};

export type HotTicker = {
  symbol: string;
  /** Same split as TickerRanking, so both tabs render one bar component. */
  bullishPercent: number | null;
  neutralPercent: number | null;
  bearishPercent: number | null;
  currentMentions: number;
  previousMentions: number;
  mentionDelta: number;
  /** Null when the previous window had none — the UI shows NEW, not Infinity. */
  growthPercent: number | null;
  hotScore: number;
  isNew: boolean;
};

export type DiscussionSummaryResult = {
  range: { from: string; to: string; label: string };
  comparison: { from: string; to: string };
  totalDiscussions: number;
  posts: number;
  comments: number;
  sentiment: { bullishPercent: number; neutralPercent: number; bearishPercent: number };
  topTickers: TickerRanking[];
  hotTickers: HotTicker[];
  minimumHotMentions: number;
  /**
   * False when the comparison window held no ticker mentions at all. Hotness
   * is then unmeasurable, and the UI should say so instead of presenting a
   * volume ranking as a trend.
   */
  comparisonAvailable: boolean;
};

/**
 * THE ONLY TWO FILTERS THE SUMMARY HAS: the window, and the communities.
 *
 * It used to take the feed's search, content type and sentiment as well, which
 * made the roll-up describe the visible page rather than the conversation. The
 * damage was worst on sentiment: filtering the feed to Bearish made the
 * breakdown report 100% bearish — a tautology dressed up as a measurement.
 * Searching "CISCO" collapsed "Total Discussions" to the handful of matching
 * rows. The two panels are meant to answer different questions, so they no
 * longer share a filter set.
 *
 * They are gone from the shape entirely rather than merely left unset by the
 * caller: an optional filter that nothing passes is one refactor away from
 * being passed again.
 */
function filterSql(alias: string, query: SummaryQuery, from: Date, to: Date): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`${Prisma.raw(alias)}.posted_at >= ${from} AND ${Prisma.raw(alias)}.posted_at <= ${to}`,
  ];

  if (query.subreddits && query.subreddits.length > 0) {
    parts.push(Prisma.sql`${Prisma.raw(alias)}.subreddit IN (${Prisma.join(query.subreddits)})`);
  }
  return Prisma.join(parts, " AND ");
}

export type MentionCounts = Map<
  string,
  { mentions: number; bullish: number; neutral: number; bearish: number }
>;

/**
 * Ticker mention counts over a window — from `ticker_activity` when it can be,
 * from the association tables when it cannot.
 *
 * The aggregated path is the point of the whole exercise: a 24h ranking becomes
 * a sum over 5-minute buckets instead of a join across every association ever
 * stored, and its cost tracks the window asked about rather than the size of
 * the corpus.
 *
 * IT IS NOT USED FOR CUSTOM RANGES. A custom window is an arbitrary duration,
 * and summing whole buckets over one would silently answer a slightly different
 * question than the one on screen — worse, a DIFFERENT slightly-different
 * question for the current window than for the comparison window, which is
 * exactly where growth percentages come from. Raw scan there; the range is
 * operator-chosen and rare.
 *
 * The flag exists for the backfill window: until history has been aggregated,
 * buckets are missing for the older half of every window, and a ranking drawn
 * from them would look authoritative while being wrong.
 */
async function mentionCounts(
  query: SummaryQuery,
  from: Date,
  to: Date,
): Promise<MentionCounts> {
  if (env.DISCUSSION_USE_AGGREGATIONS && query.range !== "custom") {
    increment("discussion_summary_from_aggregations");
    return aggregatedMentionCounts(query, from, to);
  }
  increment("discussion_summary_from_raw_scan");
  return scannedMentionCounts(query, from, to);
}

/** The pre-aggregated path. Reads `ticker_activity` and nothing else. */
async function aggregatedMentionCounts(
  query: SummaryQuery,
  from: Date,
  to: Date,
): Promise<MentionCounts> {
  const parts: Prisma.Sql[] = [
    Prisma.sql`bucket_minutes = ${BUCKET_MINUTES}`,
    Prisma.sql`bucket_start >= ${from} AND bucket_start < ${to}`,
  ];
  if (query.subreddits && query.subreddits.length > 0) {
    parts.push(Prisma.sql`subreddit IN (${Prisma.join(query.subreddits)})`);
  }

  const rows = await prisma.$queryRaw<
    { ticker: string; mentions: bigint; bullish: bigint; neutral: bigint; bearish: bigint }[]
  >(Prisma.sql`
      SELECT ticker,
             sum(mentions)::bigint AS mentions,
             sum(bullish)::bigint  AS bullish,
             sum(neutral)::bigint  AS neutral,
             sum(bearish)::bigint  AS bearish
        FROM ticker_activity
       WHERE ${Prisma.join(parts, " AND ")}
       GROUP BY ticker
      HAVING sum(mentions) > 0`);

  return new Map(
    rows.map((r) => [
      r.ticker,
      {
        mentions: Number(r.mentions),
        bullish: Number(r.bullish),
        neutral: Number(r.neutral),
        bearish: Number(r.bearish),
      },
    ]),
  );
}

/** The original path: count the associations themselves. */
async function scannedMentionCounts(
  query: SummaryQuery,
  from: Date,
  to: Date,
): Promise<MentionCounts> {
  const threshold = new Prisma.Decimal(DISPLAY_THRESHOLD);
  const pieces: Prisma.Sql[] = [];

  // ALWAYS both halves. The content-type filter used to drop one of them, so
  // "Comments" made the ticker ranking forget every post that mentioned a
  // symbol. A mention is a mention wherever it was written.
  pieces.push(Prisma.sql`
      SELECT l.ticker, p.stance
        FROM social_post_tickers l
        JOIN social_posts p ON p.id = l.social_post_id
       WHERE l.confidence >= ${threshold} AND ${filterSql("p", query, from, to)}`);
  pieces.push(Prisma.sql`
      SELECT l.ticker, c.stance
        FROM social_comment_tickers l
        JOIN social_comments c ON c.id = l.social_comment_id
       WHERE l.confidence >= ${threshold} AND ${filterSql("c", query, from, to)}`);

  const rows = await prisma.$queryRaw<
    { ticker: string; mentions: bigint; bullish: bigint; neutral: bigint; bearish: bigint }[]
  >(
    Prisma.sql`
      WITH mentions AS (${Prisma.join(pieces, " UNION ALL ")})
      SELECT ticker,
             count(*)::bigint AS mentions,
             count(*) FILTER (WHERE stance = 'bullish')::bigint AS bullish,
             count(*) FILTER (WHERE stance = 'neutral')::bigint AS neutral,
             count(*) FILTER (WHERE stance = 'bearish')::bigint AS bearish
        FROM mentions
       GROUP BY ticker`,
  );

  return new Map(
    rows.map((r) => [
      r.ticker,
      {
        mentions: Number(r.mentions),
        bullish: Number(r.bullish),
        neutral: Number(r.neutral),
        bearish: Number(r.bearish),
      },
    ]),
  );
}

/** Totals and the sentiment split for one window. */
async function totals(
  query: SummaryQuery,
  from: Date,
  to: Date,
): Promise<{ posts: number; comments: number; stance: Record<string, number> }> {
  // Posts AND comments, always: the card reports both counts separately, so
  // dropping one would leave a headline total that contradicts its own split.
  const pieces: Prisma.Sql[] = [
    Prisma.sql`
      SELECT 'post' AS kind, p.stance FROM social_posts p
       WHERE ${filterSql("p", query, from, to)}`,
    Prisma.sql`
      SELECT 'comment' AS kind, c.stance FROM social_comments c
       WHERE ${filterSql("c", query, from, to)}`,
  ];

  const rows = await prisma.$queryRaw<{ kind: string; stance: string | null; n: bigint }[]>(
    Prisma.sql`
      WITH items AS (${Prisma.join(pieces, " UNION ALL ")})
      SELECT kind, stance, count(*)::bigint AS n FROM items GROUP BY kind, stance`,
  );

  let posts = 0;
  let comments = 0;
  const stance: Record<string, number> = {};
  for (const row of rows) {
    const n = Number(row.n);
    if (row.kind === "post") posts += n;
    else comments += n;
    const key = row.stance ?? "neutral";
    stance[key] = (stance[key] ?? 0) + n;
  }
  return { posts, comments, stance };
}

/**
 * Hotness: attention that is ACCELERATING, not attention that is merely large.
 *
 * Sorting by growth percentage alone puts a symbol that went from one mention
 * to four (+300%) above one that went from 500 to 1,000 (+100%), which is
 * noise presented as insight. Two guards stop that:
 *
 *   1. A MINIMUM current volume, scaled to the window length. Below it a
 *      ticker is not ranked at all.
 *   2. A score that multiplies growth by log-scaled volume, so a large base
 *      still counts for something while a genuine surge on a modest base can
 *      still win.
 *
 *      hotScore = log1p(current) × min(current / max(previous, 1), GROWTH_CAP)
 *
 * A previous window of zero yields no percentage — that is division by zero,
 * not infinite growth — so the ticker is flagged NEW and scored against a
 * baseline of one.
 *
 * THE CAP IS WHAT KEEPS THIS FROM COLLAPSING BACK INTO "TOP TICKERS".
 * Uncapped, a zero baseline makes the growth factor equal the volume, so the
 * score becomes log1p(c)×c — monotonic in volume, and the hot list comes out in
 * exactly the same order as the top list. That is what happens on a 30-day
 * window here, because ingestion has no 60-day history to compare against yet.
 * Capping the ratio bounds how far a thin baseline can carry a symbol.
 *
 * When the comparison window is EMPTY ALTOGETHER, no acceleration exists to
 * measure, and `comparisonAvailable: false` says so rather than dressing a
 * volume ranking up as a trend.
 */
export function computeHotTickers(
  current: Map<string, { mentions: number; bullish: number; neutral: number; bearish: number }>,
  previous: Map<string, { mentions: number; bullish: number; neutral: number; bearish: number }>,
  floor: number,
  limit: number,
): HotTicker[] {
  const out: HotTicker[] = [];

  for (const [symbol, now] of current) {
    if (now.mentions < floor) continue;
    const before = previous.get(symbol)?.mentions ?? 0;
    const delta = now.mentions - before;
    if (delta <= 0) continue; // not accelerating

    const growthFactor = Math.min(now.mentions / Math.max(before, 1), GROWTH_FACTOR_CAP);
    out.push({
      symbol,
      bullishPercent: now.mentions > 0 ? Math.round((now.bullish / now.mentions) * 100) : null,
      neutralPercent: now.mentions > 0 ? Math.round((now.neutral / now.mentions) * 100) : null,
      bearishPercent: now.mentions > 0 ? Math.round((now.bearish / now.mentions) * 100) : null,
      currentMentions: now.mentions,
      previousMentions: before,
      mentionDelta: delta,
      growthPercent: before === 0 ? null : round2(((now.mentions - before) / before) * 100),
      hotScore: round2(Math.log1p(now.mentions) * growthFactor),
      isNew: before === 0,
    });
  }

  return out
    .sort((a, b) => b.hotScore - a.hotScore || b.currentMentions - a.currentMentions)
    .slice(0, limit);
}

/** Upper bound on the growth multiplier. See computeHotTickers. */
export const GROWTH_FACTOR_CAP = 10;

/** Whether this query may be answered from buckets. See mentionCounts. */
function useAggregations(query: SummaryQuery): boolean {
  return env.DISCUSSION_USE_AGGREGATIONS && query.range !== "custom";
}

export type MentionWindows = {
  currentFrom: Date;
  currentTo: Date;
  previousFrom: Date;
  previousTo: Date;
};

/**
 * The two windows MENTIONS are counted over.
 *
 * On the raw path these are simply the resolved window and its predecessor. On
 * the bucket path they are snapped to bucket boundaries, and the reason is
 * growth: hotness divides one window's count by another's, so the two must
 * cover the same NUMBER OF BUCKETS. Left unaligned, a 1h window starting at
 * 15:07 would take a partial bucket at each end while its predecessor took a
 * different pair of partials, and the ratio would carry that difference as if
 * it were a change in attention.
 *
 * The anchor is the END of the bucket in progress, so "the last hour" still
 * includes what was said a minute ago. That newest bucket is by definition
 * incomplete, which understates the current window slightly — a bias toward
 * calling a real surge late rather than calling a non-surge early, which is the
 * right direction for a list whose whole claim is that something is happening.
 */
export function mentionWindows(window: ResolvedWindow, aligned: boolean): MentionWindows {
  if (!aligned) {
    return {
      currentFrom: window.from,
      currentTo: window.to,
      previousFrom: window.previousFrom,
      previousTo: window.previousTo,
    };
  }

  const durationMs = Math.max(1, window.to.getTime() - window.from.getTime());
  const anchor = bucketStartFor(window.to).getTime() + BUCKET_MINUTES * 60_000;

  return {
    currentFrom: new Date(anchor - durationMs),
    currentTo: new Date(anchor),
    previousFrom: new Date(anchor - durationMs * 2),
    previousTo: new Date(anchor - durationMs),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function readDiscussionSummary(
  query: SummaryQuery,
): Promise<DiscussionSummaryResult> {
  increment("discussion_summary_queries");
  const window = resolveWindow(query);

  const buckets = mentionWindows(window, useAggregations(query));

  const [currentTotals, currentMentions, previousMentions] = await Promise.all([
    // Totals keep the EXACT window: they are a headline count of the
    // conversation, read straight from an indexed range on posted_at, and
    // rounding them to a bucket edge would make a live feed show new rows while
    // the number above it stayed put.
    totals(query, window.from, window.to),
    mentionCounts(query, buckets.currentFrom, buckets.currentTo),
    mentionCounts(query, buckets.previousFrom, buckets.previousTo),
  ]);

  const totalDiscussions = currentTotals.posts + currentTotals.comments;
  const denominator = totalDiscussions || 1;
  const pct = (n: number) => Math.round((n / denominator) * 100);

  const allMentions = [...currentMentions.values()].reduce((sum, v) => sum + v.mentions, 0) || 1;
  const topTickers: TickerRanking[] = [...currentMentions.entries()]
    .map(([symbol, v]) => ({
      symbol,
      mentions: v.mentions,
      mentionShare: round2((v.mentions / allMentions) * 100),
      // Percentages of the SAME denominator, so the three segments describe one
      // distribution rather than three unrelated figures.
      bullishPercent: v.mentions > 0 ? Math.round((v.bullish / v.mentions) * 100) : null,
      neutralPercent: v.mentions > 0 ? Math.round((v.neutral / v.mentions) * 100) : null,
      bearishPercent: v.mentions > 0 ? Math.round((v.bearish / v.mentions) * 100) : null,
    }))
    .sort((a, b) => b.mentions - a.mentions || a.symbol.localeCompare(b.symbol))
    .slice(0, TOP_TICKER_LIMIT);

  const floor = minimumHotMentions(window.hours);

  return {
    range: { from: window.from.toISOString(), to: window.to.toISOString(), label: window.label },
    comparison: {
      from: window.previousFrom.toISOString(),
      to: window.previousTo.toISOString(),
    },
    totalDiscussions,
    posts: currentTotals.posts,
    comments: currentTotals.comments,
    sentiment: {
      bullishPercent: pct(currentTotals.stance.bullish ?? 0),
      neutralPercent: pct(currentTotals.stance.neutral ?? 0),
      bearishPercent: pct(currentTotals.stance.bearish ?? 0),
    },
    topTickers,
    hotTickers: computeHotTickers(currentMentions, previousMentions, floor, TOP_TICKER_LIMIT),
    minimumHotMentions: floor,
    comparisonAvailable: previousMentions.size > 0,
  };
}
