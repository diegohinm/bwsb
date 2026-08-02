import type { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import {
  toAuthorHandle,
  toPreview,
  toSentiment,
  type DiscussionComment,
  type DiscussionPost,
} from "../../realtime/discussionEvents.js";

/**
 * The Discussion feed's READ path — the initial snapshot a client loads before
 * the stream starts delivering deltas.
 *
 * It reads `social_posts` / `social_comments`, the same worker-written store
 * every other ticker-social surface uses, so opening the tab costs no upstream
 * request no matter how many people have it open.
 *
 * It is a FEED, not an analysis: rows are normalized, filtered and ordered, and
 * nothing here summarizes, scores or reinterprets what was said.
 */

export const DISCUSSION_SORTS = ["newest", "upvotes", "comments"] as const;
export type DiscussionSort = (typeof DISCUSSION_SORTS)[number];

export function isDiscussionSort(value: unknown): value is DiscussionSort {
  return typeof value === "string" && (DISCUSSION_SORTS as readonly string[]).includes(value);
}

export const MAX_FEED_LIMIT = 200;
export const DEFAULT_FEED_LIMIT = 60;

export type DiscussionQuery = {
  symbol: string;
  subreddits?: string[];
  /** Only content posted at or after this instant. */
  since?: Date;
  search?: string;
  sort?: DiscussionSort;
  limit?: number;
};

export type DiscussionSnapshot = {
  posts: DiscussionPost[];
  comments: DiscussionComment[];
  meta: {
    ticker: string;
    sort: DiscussionSort;
    subreddits: string[] | null;
    since: string | null;
    search: string | null;
    postCount: number;
    commentCount: number;
    /** Providers that contributed rows — reported, never assumed. */
    providers: string[];
    isMock: boolean;
    /** Newest content instant in the snapshot, the stream's starting cursor. */
    latestAt: string | null;
  };
};

/** `tickers` is a text[]; `has` compiles to the GIN-indexed `@>` operator. */
function tickerWhere(symbol: string, subreddits?: string[], since?: Date) {
  return {
    tickers: { has: symbol.toUpperCase() },
    ...(subreddits && subreddits.length > 0 ? { subreddit: { in: subreddits } } : {}),
    ...(since ? { postedAt: { gte: since } } : {}),
  };
}

/**
 * Free-text filter over the fields a reader can actually see.
 *
 * Applied in SQL rather than after the fetch, so searching does not silently
 * search only the first page of results.
 */
function postSearch(term: string): Prisma.SocialPostsWhereInput {
  const contains = { contains: term, mode: "insensitive" as const };
  return {
    OR: [
      { title: contains },
      { body: contains },
      { subreddit: contains },
      { authorHash: contains },
    ],
  };
}

function commentSearch(term: string): Prisma.SocialCommentsWhereInput {
  const contains = { contains: term, mode: "insensitive" as const };
  return {
    OR: [{ body: contains }, { subreddit: contains }, { authorHash: contains }],
  };
}

function postOrder(sort: DiscussionSort): Prisma.SocialPostsOrderByWithRelationInput[] {
  if (sort === "upvotes") return [{ score: "desc" }, { postedAt: "desc" }];
  if (sort === "comments") return [{ commentCount: "desc" }, { postedAt: "desc" }];
  return [{ postedAt: "desc" }];
}

type PostRow = Awaited<ReturnType<typeof prisma.socialPosts.findMany>>[number];
type CommentRow = Awaited<ReturnType<typeof prisma.socialComments.findMany>>[number];

export function normalizePost(row: PostRow, symbol: string): DiscussionPost {
  return {
    id: row.externalId,
    ticker: symbol.toUpperCase(),
    subreddit: row.subreddit ?? "",
    author: toAuthorHandle(row.authorHash),
    title: row.title ?? "",
    preview: toPreview(row.body),
    upvotes: row.score,
    commentCount: row.commentCount,
    sentiment: toSentiment(row.stance),
    permalink: row.url,
    createdAt: (row.postedAt ?? row.fetchedAt).toISOString(),
  };
}

export function normalizeComment(row: CommentRow, symbol: string): DiscussionComment {
  return {
    id: row.externalId,
    ticker: symbol.toUpperCase(),
    // Null unless the source recorded the parent — reported honestly rather
    // than guessed from the URL.
    postId: row.postExternalId,
    subreddit: row.subreddit ?? "",
    author: toAuthorHandle(row.authorHash),
    preview: toPreview(row.body),
    score: row.score,
    // `social_comments` has no reply-count column; null means "not recorded",
    // and the UI omits the figure rather than printing 0.
    replyCount: null,
    sentiment: toSentiment(row.stance),
    permalink: row.url,
    createdAt: (row.postedAt ?? row.fetchedAt).toISOString(),
  };
}

/** The initial feed for one ticker. Public — no session required. */
export async function readDiscussion(query: DiscussionQuery): Promise<DiscussionSnapshot> {
  const symbol = query.symbol.toUpperCase();
  const sort: DiscussionSort = query.sort ?? "newest";
  const limit = Math.min(MAX_FEED_LIMIT, Math.max(1, query.limit ?? DEFAULT_FEED_LIMIT));
  const term = query.search?.trim() || undefined;
  const base = tickerWhere(symbol, query.subreddits, query.since);

  const [postRows, commentRows] = await Promise.all([
    prisma.socialPosts.findMany({
      where: term ? { AND: [base, postSearch(term)] } : base,
      orderBy: postOrder(sort),
      take: limit,
    }),
    prisma.socialComments.findMany({
      where: term ? { AND: [base, commentSearch(term)] } : base,
      // Comments are always newest-first: the right column is a live ticker
      // tape, and re-ranking it by score would stop it being one.
      orderBy: [{ postedAt: "desc" }],
      take: limit,
    }),
  ]);

  const posts = postRows.map((r) => normalizePost(r, symbol));
  const comments = commentRows.map((r) => normalizeComment(r, symbol));

  const providers = [
    ...new Set(
      [...postRows, ...commentRows]
        .map((r) => r.provider)
        .filter((p): p is string => Boolean(p)),
    ),
  ];

  const instants = [...posts, ...comments].map((i) => i.createdAt).sort();

  return {
    posts,
    comments,
    meta: {
      ticker: symbol,
      sort,
      subreddits: query.subreddits && query.subreddits.length > 0 ? query.subreddits : null,
      since: query.since ? query.since.toISOString() : null,
      search: term ?? null,
      postCount: posts.length,
      commentCount: comments.length,
      providers,
      isMock: providers.length > 0 && providers.every((p) => p === "mock"),
      latestAt: instants.length > 0 ? instants[instants.length - 1] : null,
    },
  };
}
