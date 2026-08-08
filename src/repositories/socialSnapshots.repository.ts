import type { SocialComments, SocialPosts } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import {
  loadTickerCatalog,
  saveCommentTickers,
  savePostTickers,
} from "./tickerAssociations.repository.js";
import { extractFromParts } from "../services/extraction/tickerExtraction.service.js";
import { classifyPostCategory } from "../services/social/dailyDiscussion.service.js";
import type {
  SocialContentType,
  SocialDataProviderName,
  SocialPostItem,
  SocialSentiment,
  SocialStance,
  SubredditPulseMetric,
  PulseTimeframe,
} from "../services/social/socialData.types.js";

/**
 * Social snapshot storage — the handoff between the ingestion worker and the API.
 *
 *   WORKER writes: saveSocialItems, savePulseSnapshot, saveTrendingTickers
 *   API reads:     readSocialItems, readLatestPulseMeta, readLatestTrendingTickers
 *
 * Posts and comments are stored in two tables (as specified) but both normalize
 * back into the same `SocialPostItem` the rest of the app already speaks, so the
 * existing aggregator and response assemblers work unchanged on DB-backed data.
 *
 * Author identities are never stored raw — only the anonymized `authorHash` the
 * provider layer produces.
 */

const COMMENT_TYPE: SocialContentType = "comment";

/** Fields shared by both tables, normalized identically. */
function baseItem(r: SocialPosts | SocialComments) {
  return {
    id: r.externalId,
    provider: (r.provider ?? "mock") as SocialDataProviderName,
    source: r.source ?? r.provider ?? "mock",
    subreddit: r.subreddit ?? "",
    ...(r.body ? { text: r.body } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(r.authorHash ? { authorHash: r.authorHash } : {}),
    ...(r.score !== null ? { score: r.score } : {}),
    createdAt: (r.postedAt ?? new Date()).toISOString(),
    tickers: r.tickers ?? [],
    sentiment: (r.sentiment ?? "neutral") as SocialSentiment,
    stance: (r.stance ?? "neutral") as SocialStance,
    confidence: num(r.confidence) ?? 0.5,
  };
}

function postToItem(r: SocialPosts): SocialPostItem {
  return {
    ...baseItem(r),
    type: (r.type ?? "post") as SocialContentType,
    ...(r.title ? { title: r.title } : {}),
    ...(r.commentCount !== null ? { numComments: r.commentCount } : {}),
    isScreenshot: r.isScreenshot,
  };
}

/** social_comments has no type/title/comment_count/is_screenshot column. */
function commentToItem(r: SocialComments): SocialPostItem {
  return {
    ...baseItem(r),
    type: COMMENT_TYPE,
    isScreenshot: false,
  };
}

// ── Worker writes ────────────────────────────────────────────────────────────

/**
 * Upsert normalized items, routing comments to `social_comments` and everything
 * else to `social_posts`. Keyed by the provider's own id, so re-ingesting the
 * same window refreshes rows instead of duplicating them.
 *
 * Items are written one at a time and NOT wrapped in a transaction: a single
 * malformed item must not discard a whole ingestion run.
 */
export async function saveSocialItems(
  items: SocialPostItem[],
): Promise<{ posts: number; comments: number }> {
  let posts = 0;
  let comments = 0;
  const pending: PendingAssociation[] = [];

  for (const it of items) {
    if (it.type === COMMENT_TYPE) {
      const row = await prisma.socialComments.upsert({
        where: { externalId: it.id },
        create: {
          externalId: it.id,
          provider: it.provider,
          source: it.source,
          subreddit: it.subreddit,
          postExternalId: null,
          body: it.text ?? null,
          url: it.url ?? null,
          authorHash: it.authorHash ?? null,
          score: it.score ?? null,
          tickers: it.tickers,
          sentiment: it.sentiment,
          stance: it.stance,
          confidence: it.confidence,
          postedAt: it.createdAt,
        },
        // Only the volatile fields are refreshed — the identity and body of an
        // already-ingested comment stay as first captured.
        update: {
          score: it.score ?? null,
          tickers: it.tickers,
          sentiment: it.sentiment,
          stance: it.stance,
          confidence: it.confidence,
          fetchedAt: new Date(),
        },
      });
      pending.push({ kind: "comment", rowId: row.id, item: it });
      comments += 1;
    } else {
      const row = await prisma.socialPosts.upsert({
        where: { externalId: it.id },
        create: {
          externalId: it.id,
          provider: it.provider,
          source: it.source,
          subreddit: it.subreddit,
          type: it.type,
          title: it.title ?? null,
          body: it.text ?? null,
          url: it.url ?? null,
          authorHash: it.authorHash ?? null,
          score: it.score ?? null,
          commentCount: it.numComments ?? null,
          tickers: it.tickers,
          sentiment: it.sentiment,
          stance: it.stance,
          confidence: it.confidence,
          isScreenshot: it.isScreenshot,
          // Classified HERE, once, so the read path is an indexed filter
          // rather than a title match it cannot index.
          postCategory: classifyPostCategory(it.title, it.subreddit, it.flair),
          postedAt: it.createdAt,
        },
        update: {
          score: it.score ?? null,
          commentCount: it.numComments ?? null,
          // Re-evaluated on update too: a post edited into (or out of) the
          // daily format must not keep a stale category forever.
          postCategory: classifyPostCategory(it.title, it.subreddit, it.flair),
          tickers: it.tickers,
          sentiment: it.sentiment,
          stance: it.stance,
          confidence: it.confidence,
          isScreenshot: it.isScreenshot,
          fetchedAt: new Date(),
        },
      });
      pending.push({ kind: "post", rowId: row.id, item: it });
      posts += 1;
    }
  }

  await attachTickers(pending);

  return { posts, comments };
}

type PendingAssociation = {
  kind: "post" | "comment";
  rowId: string;
  item: SocialPostItem;
};

/**
 * Extract and persist ticker associations for freshly stored content.
 *
 * RUNS AFTER PERSISTENCE, AND CANNOT UNDO IT. The content rows are already
 * committed by the time this is called, and every failure path below is
 * swallowed and logged. A catalog read that times out, or one item whose text
 * trips the extractor, must never cost us the Reddit post itself — the
 * association can be recovered later by `social:backfill-tickers`, the post
 * cannot be recovered at all once the provider window has moved on.
 */
async function attachTickers(pending: PendingAssociation[]): Promise<void> {
  if (pending.length === 0) return;

  let catalog;
  try {
    // Once per batch, not once per item.
    catalog = await loadTickerCatalog();
  } catch (err) {
    console.error("[social] ticker catalog unavailable, skipping extraction:", err);
    return;
  }

  for (const entry of pending) {
    try {
      const matches = extractFromParts(catalog, entry.item.title, entry.item.text);
      if (entry.kind === "post") await savePostTickers(entry.rowId, matches);
      else await saveCommentTickers(entry.rowId, matches);
    } catch (err) {
      console.error(`[social] ticker extraction failed for ${entry.item.id}:`, err);
    }
  }
}

export interface PulseSnapshotInput {
  timeframe: PulseTimeframe;
  provider: string;
  source: string;
  isMock: boolean;
  warning: string | null;
  subreddits: SubredditPulseMetric[];
}

/** Append one pulse snapshot (one row per subreddit, shared snapshot_at). */
export async function savePulseSnapshot(
  input: PulseSnapshotInput,
  snapshotAt: string,
): Promise<number> {
  if (input.subreddits.length === 0) return 0;

  const created = await prisma.subredditPulseSnapshots.createMany({
    data: input.subreddits.map((s) => ({
      timeframe: input.timeframe,
      subreddit: s.subreddit,
      activityScore: s.activityScore,
      mentions: s.mentions,
      changePct: s.changePct,
      mood: s.mood,
      topTickers: s.topTickers,
      sentiment: s.sentiment,
      stance: s.stance,
      provider: input.provider,
      source: input.source,
      isMock: input.isMock,
      warning: input.warning,
      snapshotAt,
    })),
  });
  return created.count;
}

export interface TrendingTickerInput {
  timeframe: PulseTimeframe;
  symbol: string;
  mentionCount: number;
  sentiment: SocialSentiment;
  stance: SocialStance;
  price: number | null;
  changePct: number | null;
  providerSocial: string;
  providerMarket: string;
  isMock: boolean;
}

/** Append one trending-ticker snapshot (what the moving strip reads). */
export async function saveTrendingTickers(
  rows: TrendingTickerInput[],
  snapshotAt: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  const created = await prisma.trendingTickerSnapshots.createMany({
    data: rows.map((r) => ({
      timeframe: r.timeframe,
      symbol: r.symbol.toUpperCase(),
      mentionCount: r.mentionCount,
      sentiment: r.sentiment,
      stance: r.stance,
      price: r.price,
      changePct: r.changePct,
      providerSocial: r.providerSocial,
      providerMarket: r.providerMarket,
      isMock: r.isMock,
      snapshotAt,
    })),
  });
  return created.count;
}

// ── API reads ────────────────────────────────────────────────────────────────

/**
 * Normalized items (posts + comments) inside a time window, newest first.
 * `ticker` restricts to items mentioning that symbol — `hasSome` compiles to the
 * array-overlap operator, which is what the GIN index on `tickers` serves.
 *
 * `subreddits` restricts to a set of communities. The narrowing happens in SQL
 * (`subreddit IN (…)`), NOT after the fact in JS — a filtered Pulse request must
 * not pay to read rows it will discard, and must not have its `limit` consumed
 * by rows from unselected communities.
 */
export async function readSocialItems(params: {
  sinceIso: string;
  limit?: number;
  ticker?: string;
  subreddit?: string;
  subreddits?: readonly string[];
}): Promise<SocialPostItem[]> {
  const limit = Math.min(2_000, params.limit ?? 1_000);

  // The same filter runs against both tables; each contributes up to `limit`
  // rows, matching the previous two-query behaviour.
  const where = {
    postedAt: { gte: new Date(params.sinceIso) },
    ...(params.ticker ? { tickers: { hasSome: [params.ticker.toUpperCase()] } } : {}),
    ...(params.subreddit ? { subreddit: params.subreddit } : {}),
    ...(params.subreddits?.length ? { subreddit: { in: [...params.subreddits] } } : {}),
  };

  const [posts, comments] = await Promise.all([
    prisma.socialPosts.findMany({
      where,
      orderBy: { postedAt: "desc" },
      take: limit,
    }),
    prisma.socialComments.findMany({
      where,
      orderBy: { postedAt: "desc" },
      take: limit,
    }),
  ]);

  return [...posts.map(postToItem), ...comments.map(commentToItem)];
}

export interface PulseSnapshotMeta {
  timeframe: PulseTimeframe;
  provider: string;
  source: string;
  isMock: boolean;
  warning: string | null;
  snapshotAt: string;
}

/** Provenance of the newest stored pulse snapshot for a timeframe. */
export async function readLatestPulseMeta(
  timeframe: PulseTimeframe,
): Promise<PulseSnapshotMeta | null> {
  const r = await prisma.subredditPulseSnapshots.findFirst({
    where: { timeframe },
    orderBy: { snapshotAt: "desc" },
  });
  if (!r) return null;

  return {
    timeframe: r.timeframe as PulseTimeframe,
    provider: r.provider ?? "mock",
    source: r.source ?? r.provider ?? "mock",
    isMock: r.isMock,
    warning: r.warning,
    snapshotAt: r.snapshotAt.toISOString(),
  };
}

export interface StoredTrendingTicker {
  symbol: string;
  mentionCount: number;
  sentiment: SocialSentiment;
  stance: SocialStance;
  price: number | null;
  changePct: number | null;
  providerSocial: string;
  providerMarket: string;
  isMock: boolean;
  snapshotAt: string;
}

/** The newest trending-ticker snapshot for a timeframe. */
export async function readLatestTrendingTickers(
  timeframe: PulseTimeframe,
  limit: number,
): Promise<StoredTrendingTicker[]> {
  // Newest snapshot_at first, then only that batch — rows from an earlier run
  // must never be blended into the current strip.
  const newest = await prisma.trendingTickerSnapshots.aggregate({
    where: { timeframe },
    _max: { snapshotAt: true },
  });
  if (!newest._max.snapshotAt) return [];

  const rows = await prisma.trendingTickerSnapshots.findMany({
    where: { timeframe, snapshotAt: newest._max.snapshotAt },
    orderBy: { mentionCount: { sort: "desc", nulls: "last" } },
    take: limit,
  });

  return rows.map((r) => ({
    symbol: r.symbol,
    mentionCount: r.mentionCount ?? 0,
    sentiment: (r.sentiment ?? "neutral") as SocialSentiment,
    stance: (r.stance ?? "neutral") as SocialStance,
    price: num(r.price),
    changePct: num(r.changePct),
    providerSocial: r.providerSocial ?? "mock",
    providerMarket: r.providerMarket ?? "mock",
    isMock: r.isMock,
    snapshotAt: r.snapshotAt.toISOString(),
  }));
}
