import { createHash } from "node:crypto";

import { prisma } from "../lib/prisma.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
} from "../providers/reddit/types.js";

/**
 * Persistence for Reddit content produced by the provider layer
 * (src/providers/reddit/).
 *
 * WRITES ONLY — the API never calls this; it reads `reddit_posts` through
 * posts.repository.ts. Only the ingestion worker writes here.
 *
 * THE UPSERT CONTRACT (why this is not a one-line `prisma.upsert`)
 *   - keyed on the real Reddit id, so the same post arriving from two providers
 *     updates one row instead of inserting a second;
 *   - `sources` accumulates: a row first seen via Arctic Shift and later
 *     confirmed by Mindcase ends up with both, never with the last writer's
 *     value alone;
 *   - a stored body is NEVER overwritten with null. Providers differ in how
 *     much text they return, and a listing endpoint that omits `selftext` must
 *     not erase a full DD post that another provider captured;
 *   - `createdAt` (the Reddit timestamp) is written once and never moved;
 *   - `score` / `commentCount` / `lastSeenAt` always refresh — that is the
 *     point of re-ingesting.
 *
 * PRIVACY: raw Reddit usernames are never stored. `author_hash` holds a
 * truncated SHA-256 of the username, matching the anonymization the social
 * pipeline already uses, so no table in this database can identify an author.
 */

/** Sentinel hash for deleted/removed/absent authors. */
const ANON_UNKNOWN = "anon_unknown";

/** One-way, stable author reference. Never reversible to a username. */
export function hashAuthor(author: string | null): string {
  if (!author) return ANON_UNKNOWN;
  return `anon_${createHash("sha256").update(author).digest("hex").slice(0, 12)}`;
}

export interface SaveResult {
  created: number;
  updated: number;
  /** Records that could not be written; the run continues regardless. */
  failed: number;
}

export interface SavePostsOptions {
  /** REDDIT_STORE_SOURCE_METADATA — persist the upstream payload. */
  storeRawData?: boolean;
  /** Tickers detected per post, keyed by externalId. */
  tickersByPost?: Map<string, string[]>;
}

/** Merge two provider lists without duplicates, preserving order. */
function mergeSources(stored: string[], incoming: string[]): string[] {
  return [...new Set([...stored, ...incoming])];
}

/** Keep whichever body actually has content; longer wins between two. */
function keepRicherText(stored: string | null, incoming: string | null): string | null {
  if (incoming === null) return stored;
  if (stored === null) return incoming;
  return incoming.length > stored.length ? incoming : stored;
}

/**
 * Upsert posts one at a time, NOT in a transaction: a single malformed record
 * must never discard a whole ingestion run.
 */
export async function saveRedditPosts(
  posts: NormalizedRedditPost[],
  options: SavePostsOptions = {},
): Promise<SaveResult> {
  const result: SaveResult = { created: 0, updated: 0, failed: 0 };

  for (const post of posts) {
    try {
      const existing = await prisma.redditPosts.findUnique({
        where: { redditPostId: post.externalId },
        select: { bodyExcerpt: true, sources: true },
      });

      const lastSeenAt = post.fetchedAt;
      const rawData =
        options.storeRawData && post.raw !== undefined
          ? (post.raw as object)
          : undefined;

      if (!existing) {
        await prisma.redditPosts.create({
          data: {
            redditPostId: post.externalId,
            subreddit: post.subreddit,
            title: post.title,
            bodyExcerpt: post.body,
            authorHash: hashAuthor(post.author),
            score: post.score,
            numComments: post.commentCount,
            permalink: post.permalink,
            redditCreatedAt: post.createdAt,
            fullname: post.fullname,
            url: post.url,
            upvoteRatio: post.upvoteRatio,
            source: post.primarySource,
            sources: post.sources,
            fetchedAt: post.fetchedAt,
            lastSeenAt,
            ...(rawData !== undefined ? { rawData } : {}),
          },
        });
        result.created += 1;
      } else {
        await prisma.redditPosts.update({
          where: { redditPostId: post.externalId },
          data: {
            // Volatile — always refreshed.
            score: post.score,
            numComments: post.commentCount,
            upvoteRatio: post.upvoteRatio,
            lastSeenAt,
            // Never regress to null.
            bodyExcerpt: keepRicherText(existing.bodyExcerpt, post.body),
            // Accumulated, never replaced.
            sources: mergeSources(existing.sources, post.sources),
            source: post.primarySource,
            // NOT updated: redditCreatedAt, fetchedAt, title, authorHash —
            // the record's identity and first-capture time do not change.
            ...(rawData !== undefined ? { rawData } : {}),
          },
        });
        result.updated += 1;
      }

      const tickers = options.tickersByPost?.get(post.externalId) ?? [];
      if (tickers.length > 0) await saveTickerMentions(post.externalId, tickers);
    } catch (error) {
      result.failed += 1;
      console.error(
        `[redditContent] failed to store post ${post.externalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

/**
 * Upsert comments. `postExternalId` is stored as `reddit_post_id`, but ONLY
 * when that post already exists — the column is a foreign key, and a comment
 * whose parent has not been ingested yet is stored unlinked rather than
 * dropped.
 */
export async function saveRedditComments(
  comments: NormalizedRedditComment[],
  options: { storeRawData?: boolean } = {},
): Promise<SaveResult> {
  const result: SaveResult = { created: 0, updated: 0, failed: 0 };

  // One lookup for the whole batch instead of one per comment.
  const parentIds = [...new Set(comments.map((c) => c.postId).filter(Boolean))];
  const knownParents = new Set(
    (
      await prisma.redditPosts.findMany({
        where: { redditPostId: { in: parentIds } },
        select: { redditPostId: true },
      })
    ).map((row) => row.redditPostId),
  );

  for (const comment of comments) {
    try {
      const existing = await prisma.redditComments.findUnique({
        where: { redditCommentId: comment.externalId },
        select: { bodyExcerpt: true, sources: true },
      });

      const linkedPostId = knownParents.has(comment.postId) ? comment.postId : null;
      const rawData =
        options.storeRawData && comment.raw !== undefined
          ? (comment.raw as object)
          : undefined;

      if (!existing) {
        await prisma.redditComments.create({
          data: {
            redditCommentId: comment.externalId,
            redditPostId: linkedPostId,
            subreddit: comment.subreddit,
            authorHash: hashAuthor(comment.author),
            bodyExcerpt: comment.body,
            score: comment.score,
            redditCreatedAt: comment.createdAt,
            fullname: comment.fullname,
            parentId: comment.parentId,
            permalink: comment.permalink,
            source: comment.primarySource,
            sources: comment.sources,
            fetchedAt: comment.fetchedAt,
            lastSeenAt: comment.fetchedAt,
            ...(rawData !== undefined ? { rawData } : {}),
          },
        });
        result.created += 1;
      } else {
        await prisma.redditComments.update({
          where: { redditCommentId: comment.externalId },
          data: {
            score: comment.score,
            lastSeenAt: comment.fetchedAt,
            bodyExcerpt: keepRicherText(existing.bodyExcerpt, comment.body),
            sources: mergeSources(existing.sources, comment.sources),
            source: comment.primarySource,
            // Link the parent post if it has been ingested since.
            ...(linkedPostId ? { redditPostId: linkedPostId } : {}),
            ...(rawData !== undefined ? { rawData } : {}),
          },
        });
        result.updated += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.error(
        `[redditContent] failed to store comment ${comment.externalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

/**
 * Record which tickers a post mentions.
 *
 * `ticker_mentions.ticker` is a foreign key into the ticker catalog, so symbols
 * that are not in `tickers` are skipped: an unknown cashtag must not fail the
 * ingestion of an otherwise good post.
 */
async function saveTickerMentions(
  redditPostId: string,
  tickers: string[],
): Promise<void> {
  const known = await prisma.tickers.findMany({
    where: { ticker: { in: tickers.map((t) => t.toUpperCase()) } },
    select: { ticker: true },
  });
  if (known.length === 0) return;

  await prisma.tickerMentions.createMany({
    data: known.map((row) => ({ ticker: row.ticker, redditPostId })),
    // Re-ingesting a post must not duplicate its mentions.
    skipDuplicates: true,
  });
}

/**
 * Newest Reddit timestamp stored for a subreddit — the ingestion watermark.
 * `null` when nothing has been ingested yet (first run, full window).
 */
export async function latestPostTimestamp(
  subreddit: string,
): Promise<Date | null> {
  const row = await prisma.redditPosts.findFirst({
    where: { subreddit },
    orderBy: { redditCreatedAt: { sort: "desc", nulls: "last" } },
    select: { redditCreatedAt: true },
  });
  return row?.redditCreatedAt ?? null;
}
