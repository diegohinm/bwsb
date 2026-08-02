import { prisma } from "../../lib/prisma.js";
import { PULSE_TIMEFRAME_MS, type PulseTimeframe } from "../social/socialData.types.js";
import { normalizeSubreddit } from "../social/subreddits.js";
import {
  BUCKET_FOR_TIMEFRAME,
  BUCKET_MS,
  type BucketSize,
} from "../../repositories/tickerSocialMetrics.repository.js";

/**
 * Reddit mention & sentiment series for ONE ticker.
 *
 * Reads stored content only (`social_posts` / `social_comments`) — this is a
 * single-symbol, windowed query served by the GIN index on `tickers`, not a
 * catalog-wide scan. No provider is contacted, so hovering a bar or toggling a
 * community costs a database read at most.
 *
 * Counting rule: ONE MENTION PER CONTENT ITEM per ticker. A post that says NVDA
 * six times is one mention, because the alternative rewards repetition and
 * inflates exactly the number the chart exists to report.
 *
 * Direction, not mood: the `stance` column records where the author stands ON
 * THE TRADE. "Great company, buying puts" is bearish here even though the
 * sentiment about the company is positive — and anything the classifier could
 * not read with confidence stays NEUTRAL rather than being guessed.
 */

export const MENTION_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type MentionRange = (typeof MENTION_RANGES)[number];

export function isMentionRange(value: unknown): value is MentionRange {
  return typeof value === "string" && (MENTION_RANGES as readonly string[]).includes(value);
}

/** Days of history used for the same-hour comparison. */
const HISTORY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Below this many comparable prior days, the average is null, not a guess. */
const MIN_HISTORY_DAYS = 3;

/** Authors that are not people, or not identifiable. */
const IGNORED_AUTHORS = new Set(["", "deleted", "[deleted]", "automoderator"]);

export interface MentionBucket {
  bucketStart: string;
  bucketEnd: string;
  bullishCount: number;
  neutralCount: number;
  bearishCount: number;
  totalMentions: number;
  uniqueAuthors: number;
  postCount: number;
  commentCount: number;
  /** Mean mentions in the same clock slot over the previous days, or null. */
  historicalAverage: number | null;
}

export interface MentionSummary {
  totalMentions: number;
  bullishCount: number;
  neutralCount: number;
  bearishCount: number;
  bullishPercentage: number;
  neutralPercentage: number;
  bearishPercentage: number;
  netSentiment: number;
  netSentimentLabel: string;
  /** Change vs the immediately preceding window of the same length. */
  mentionChangePercentage: number | null;
  /** Current volume ÷ the same window's average over the previous days. */
  mentionVelocity: number | null;
  uniqueAuthors: number;
  postCount: number;
  commentCount: number;
  /** Share of mentions written by distinct authors — a crude spam signal. */
  uniqueAuthorRatio: number | null;
}

export interface MentionSeries {
  ticker: string;
  range: MentionRange;
  bucket: BucketSize;
  subreddits: string[];
  summary: MentionSummary;
  buckets: MentionBucket[];
  updatedAt: string | null;
}

type Item = {
  postedAt: Date;
  stance: string | null;
  authorHash: string | null;
  isComment: boolean;
};

/**
 * Net sentiment bands. Stated as a table rather than nested conditionals so the
 * boundaries are auditable against the product spec.
 */
export function netSentimentLabel(net: number): string {
  if (net >= 50) return "Strong Bullish";
  if (net >= 20) return "Bullish";
  if (net >= -19) return "Mixed";
  if (net >= -49) return "Bearish";
  return "Strong Bearish";
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

function floorTo(ms: number, sizeMs: number): number {
  return Math.floor(ms / sizeMs) * sizeMs;
}

function usableAuthor(hash: string | null): boolean {
  return Boolean(hash) && !IGNORED_AUTHORS.has((hash ?? "").trim().toLowerCase());
}

/** Canonical names for a `subreddits=` filter, or undefined for "all". */
export function parseSubredditFilter(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const names = raw
    .split(",")
    .map((s) => normalizeSubreddit(s))
    .filter((s): s is string => Boolean(s));
  return names.length > 0 ? [...new Set(names)] : undefined;
}

export async function getSeries(params: {
  ticker: string;
  range: MentionRange;
  subreddits?: string[];
  now?: Date;
}): Promise<MentionSeries> {
  const ticker = params.ticker.toUpperCase();
  const bucket = BUCKET_FOR_TIMEFRAME[params.range as PulseTimeframe];
  const bucketMs = BUCKET_MS[bucket];
  const now = (params.now ?? new Date()).getTime();
  const rangeMs = PULSE_TIMEFRAME_MS[params.range as PulseTimeframe];

  const windowStart = floorTo(now - rangeMs, bucketMs);
  // Reach back a full history period so the same-hour average and the
  // previous-window comparison come from one query instead of three.
  const queryStart = new Date(windowStart - HISTORY_DAYS * DAY_MS);

  const where = {
    tickers: { hasSome: [ticker] },
    postedAt: { gte: queryStart },
    ...(params.subreddits?.length ? { subreddit: { in: params.subreddits } } : {}),
  };
  const select = { postedAt: true, stance: true, authorHash: true } as const;

  const [posts, comments] = await Promise.all([
    prisma.socialPosts.findMany({ where, select }),
    prisma.socialComments.findMany({ where, select }),
  ]);

  const items: Item[] = [
    ...posts.map((p) => ({ ...p, postedAt: p.postedAt ?? new Date(0), isComment: false })),
    ...comments.map((c) => ({ ...c, postedAt: c.postedAt ?? new Date(0), isComment: true })),
  ].filter((i) => i.postedAt.getTime() > 0);

  // ── Bucket every item once ─────────────────────────────────────────────────
  type Acc = {
    bullish: number;
    neutral: number;
    bearish: number;
    posts: number;
    comments: number;
    authors: Set<string>;
  };
  const byBucket = new Map<number, Acc>();
  const emptyAcc = (): Acc => ({
    bullish: 0,
    neutral: 0,
    bearish: 0,
    posts: 0,
    comments: 0,
    authors: new Set(),
  });

  let newest: number | null = null;
  for (const item of items) {
    const key = floorTo(item.postedAt.getTime(), bucketMs);
    let acc = byBucket.get(key);
    if (!acc) {
      acc = emptyAcc();
      byBucket.set(key, acc);
    }
    if (item.stance === "bullish") acc.bullish += 1;
    else if (item.stance === "bearish") acc.bearish += 1;
    else acc.neutral += 1;
    if (item.isComment) acc.comments += 1;
    else acc.posts += 1;
    if (usableAuthor(item.authorHash)) acc.authors.add(item.authorHash!);
    if (newest === null || item.postedAt.getTime() > newest) newest = item.postedAt.getTime();
  }

  const totalOf = (acc: Acc | undefined): number =>
    acc ? acc.bullish + acc.neutral + acc.bearish : 0;

  /**
   * Mean volume in the same clock slot on the previous days. Null — never 0 —
   * when the history is too thin to compare against: an absent measurement is
   * not a measurement of zero.
   */
  function historicalAverage(bucketStart: number): number | null {
    const oldest = items.length
      ? Math.min(...items.map((i) => i.postedAt.getTime()))
      : bucketStart;
    const daysAvailable = Math.min(
      HISTORY_DAYS,
      Math.floor((bucketStart - oldest) / DAY_MS),
    );
    if (daysAvailable < MIN_HISTORY_DAYS) return null;

    let sum = 0;
    for (let day = 1; day <= daysAvailable; day += 1) {
      sum += totalOf(byBucket.get(bucketStart - day * DAY_MS));
    }
    return Math.round((sum / daysAvailable) * 10) / 10;
  }

  // ── The visible window, empty buckets included ─────────────────────────────
  const buckets: MentionBucket[] = [];
  for (let start = windowStart; start < now; start += bucketMs) {
    const acc = byBucket.get(start);
    const total = totalOf(acc);
    buckets.push({
      bucketStart: new Date(start).toISOString(),
      bucketEnd: new Date(start + bucketMs).toISOString(),
      bullishCount: acc?.bullish ?? 0,
      neutralCount: acc?.neutral ?? 0,
      bearishCount: acc?.bearish ?? 0,
      totalMentions: total,
      uniqueAuthors: acc?.authors.size ?? 0,
      postCount: acc?.posts ?? 0,
      commentCount: acc?.comments ?? 0,
      historicalAverage: historicalAverage(start),
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const inWindow = items.filter((i) => i.postedAt.getTime() >= windowStart);
  const bullishCount = inWindow.filter((i) => i.stance === "bullish").length;
  const bearishCount = inWindow.filter((i) => i.stance === "bearish").length;
  const neutralCount = inWindow.length - bullishCount - bearishCount;
  const totalMentions = inWindow.length;

  const bullishPercentage = pct(bullishCount, totalMentions);
  const bearishPercentage = pct(bearishCount, totalMentions);
  const neutralPercentage = totalMentions > 0
    ? 100 - bullishPercentage - bearishPercentage
    : 0;

  const previousWindow = items.filter(
    (i) =>
      i.postedAt.getTime() >= windowStart - rangeMs && i.postedAt.getTime() < windowStart,
  ).length;

  // Velocity compares this window against the same-length window on each of the
  // previous days — the "2.31x vs 7-day average" figure.
  const priorWindows: number[] = [];
  for (let day = 1; day <= HISTORY_DAYS; day += 1) {
    const from = windowStart - day * DAY_MS;
    const to = from + rangeMs;
    if (from < queryStart.getTime()) break;
    priorWindows.push(
      items.filter((i) => i.postedAt.getTime() >= from && i.postedAt.getTime() < to).length,
    );
  }
  const priorMean =
    priorWindows.length >= MIN_HISTORY_DAYS
      ? priorWindows.reduce((s, n) => s + n, 0) / priorWindows.length
      : null;

  const uniqueAuthors = new Set(
    inWindow.filter((i) => usableAuthor(i.authorHash)).map((i) => i.authorHash!),
  ).size;

  const netSentiment = bullishPercentage - bearishPercentage;

  return {
    ticker,
    range: params.range,
    bucket,
    subreddits: params.subreddits ?? [],
    summary: {
      totalMentions,
      bullishCount,
      neutralCount,
      bearishCount,
      bullishPercentage,
      neutralPercentage,
      bearishPercentage,
      netSentiment,
      netSentimentLabel: netSentimentLabel(netSentiment),
      mentionChangePercentage:
        previousWindow > 0
          ? Math.round(((totalMentions - previousWindow) / previousWindow) * 100)
          : null,
      mentionVelocity:
        priorMean && priorMean > 0 ? Math.round((totalMentions / priorMean) * 100) / 100 : null,
      uniqueAuthors,
      postCount: inWindow.filter((i) => !i.isComment).length,
      commentCount: inWindow.filter((i) => i.isComment).length,
      uniqueAuthorRatio: totalMentions > 0 ? pct(uniqueAuthors, totalMentions) : null,
    },
    buckets,
    updatedAt: newest ? new Date(newest).toISOString() : null,
  };
}
