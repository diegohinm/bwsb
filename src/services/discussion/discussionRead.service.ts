import type { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import {
  badgesForComments,
  badgesForPosts,
  type TickerBadge,
} from "../../repositories/tickerAssociations.repository.js";
import { DISPLAY_THRESHOLD } from "../extraction/tickerExtraction.service.js";
import {
  DAILY_DISCUSSION_SUBREDDIT,
  DAILY_DISCUSSION_WINDOW_HOURS,
} from "../social/dailyDiscussion.service.js";
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

export const CONTENT_TYPES = ["all", "post", "comment", "daily_discussion"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const SENTIMENTS = ["all", "bullish", "neutral", "bearish"] as const;
export type SentimentFilter = (typeof SENTIMENTS)[number];

export function isContentType(v: unknown): v is ContentType {
  return typeof v === "string" && (CONTENT_TYPES as readonly string[]).includes(v);
}
export function isSentimentFilter(v: unknown): v is SentimentFilter {
  return typeof v === "string" && (SENTIMENTS as readonly string[]).includes(v);
}

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
      // Searching "NVDA" must also return a post that only ever said "Nvidia".
      // The association is what the reader sees as a badge, so it is what the
      // search has to honour — matching the raw text alone would return a
      // different set than the one on screen.
      { tickerLinks: { some: tickerLinkFilter(term) } },
    ],
  };
}

function commentSearch(term: string): Prisma.SocialCommentsWhereInput {
  const contains = { contains: term, mode: "insensitive" as const };
  return {
    OR: [
      { body: contains },
      { subreddit: contains },
      { authorHash: contains },
      { tickerLinks: { some: tickerLinkFilter(term) } },
    ],
  };
}

/**
 * Match an association by symbol or company name, but only one strong enough to
 * be displayed — searching must not surface a row whose badge is hidden.
 */
function tickerLinkFilter(term: string) {
  return {
    confidence: { gte: DISPLAY_THRESHOLD },
    tickers: {
      is: {
        OR: [
          { ticker: { equals: term.toUpperCase() } },
          { companyName: { contains: term, mode: "insensitive" as const } },
        ],
      },
    },
  };
}

function postOrder(sort: DiscussionSort): Prisma.SocialPostsOrderByWithRelationInput[] {
  if (sort === "upvotes") return [{ score: "desc" }, { postedAt: "desc" }];
  if (sort === "comments") return [{ commentCount: "desc" }, { postedAt: "desc" }];
  return [{ postedAt: "desc" }];
}

type PostRow = Awaited<ReturnType<typeof prisma.socialPosts.findMany>>[number];
type CommentRow = Awaited<ReturnType<typeof prisma.socialComments.findMany>>[number];

/**
 * A Reddit permalink for the row.
 *
 * Prefers the stored `url`. When a source recorded none (some feeds only put
 * the link inside the body — the daily megathread is one), the FIRST real
 * Reddit URL in the text is recovered. This never fabricates a link: it only
 * surfaces one the content already contains, so the Open action opens a page
 * that genuinely exists. Null when neither is present, and the UI then disables
 * the action rather than guessing.
 *
 * Any official Reddit host is accepted — an arbitrary single-label subdomain of
 * reddit.com (`www`, `old`, `np`, `new`, `m`, `i`, `oauth`, and the share host
 * `sh.reddit.com`) plus `redd.it` short links. The trailing `/` after the host
 * is required so a look-alike like `reddit.com.evil.example/…` cannot match.
 *
 * The character class also excludes Markdown link punctuation (`(`, `)`, `[`,
 * `]`) so a self-link written as `[https://…/faq](https://…/faq)` yields the
 * bare URL, never the `…/faq](https://…` residue that made a previous href
 * unnavigable. What survives the regex is then parsed with `URL` and its host
 * re-checked against the allow-list, so nothing but a genuine Reddit URL is ever
 * returned.
 */
const REDDIT_URL =
  /https?:\/\/(?:(?:[a-z0-9-]+\.)?reddit\.com|redd\.it)\/[^\s<>"'()[\]]+/i;
function isOfficialRedditHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "reddit.com" || h === "redd.it" || h.endsWith(".reddit.com");
}
export function resolvePermalink(url: string | null, body: string | null): string | null {
  if (url && url.trim()) return url;
  const match = body?.match(REDDIT_URL);
  if (!match) return null;
  // Trim any trailing prose punctuation glued to the URL by the surrounding
  // text before validating it as a real, navigable link.
  const candidate = match[0].replace(/[.,;:!?'")\]}>]+$/, "");
  try {
    const parsed = new URL(candidate);
    return isOfficialRedditHost(parsed.hostname) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function normalizePost(
  row: PostRow,
  symbol: string,
  tickers: TickerBadge[] = [],
): DiscussionPost {
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
    tickers,
    permalink: resolvePermalink(row.url, row.body),
    createdAt: (row.postedAt ?? row.fetchedAt).toISOString(),
  };
}

export function normalizeComment(
  row: CommentRow,
  symbol: string,
  tickers: TickerBadge[] = [],
): DiscussionComment {
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
    tickers,
    permalink: resolvePermalink(row.url, row.body),
    createdAt: (row.postedAt ?? row.fetchedAt).toISOString(),
  };
}

export type GlobalDiscussionQuery = {
  subreddits?: string[];
  contentType?: ContentType;
  sentiment?: SentimentFilter;
  /** Inclusive lower/upper bounds on `postedAt`. */
  from?: Date;
  to?: Date;
  search?: string;
  sort?: DiscussionSort;
  limit?: number;
};

export type FeedItem =
  | ({ kind: "post" } & DiscussionPost)
  | ({ kind: "comment" } & DiscussionComment);

/** Which daily thread the feed is currently showing, when that filter is on. */
export type DailyDiscussionThread = {
  postId: string;
  title: string;
  createdAt: string;
};

export type GlobalDiscussionResult = {
  items: FeedItem[];
  meta: {
    contentType: ContentType;
    sentiment: SentimentFilter;
    sort: DiscussionSort;
    subreddits: string[] | null;
    from: string | null;
    to: string | null;
    search: string | null;
    postCount: number;
    commentCount: number;
    providers: string[];
    isMock: boolean;
    latestAt: string | null;
    /**
     * Present only for `daily_discussion`. Null means the filter is on but no
     * thread was found inside the window — the UI says so rather than quietly
     * falling back to ordinary content.
     */
    dailyDiscussion?: DailyDiscussionThread | null;
    /**
     * The current r/wallstreetbets daily megathread, resolved on EVERY global
     * request (not just in daily mode) so the feed can show its compact
     * "SOURCE THREAD:" line over any filter. Null when none is indexed inside
     * the window — the line is then omitted rather than invented.
     */
    sourceThread?: DailyDiscussionThread | null;
  };
};

/**
 * The newest r/wallstreetbets daily thread inside the window.
 *
 * ONE thread, never several. Merging two days of megathread would produce a
 * feed with no coherent subject and a "source thread" label that lies about
 * half its rows. The "tomorrow" thread appears the previous evening and a
 * weekend thread spans two days, which is why the window is 48 hours rather
 * than a calendar day.
 *
 * Returns null rather than falling back to a regular post: an empty daily feed
 * is a true statement, a feed of unrelated posts labelled "daily discussion" is
 * not.
 */
export async function findLatestDailyDiscussionThread(
  now: Date = new Date(),
): Promise<DailyDiscussionThread | null> {
  const since = new Date(now.getTime() - DAILY_DISCUSSION_WINDOW_HOURS * 60 * 60 * 1000);

  const row = await prisma.socialPosts.findFirst({
    where: {
      postCategory: "DAILY_DISCUSSION",
      subreddit: DAILY_DISCUSSION_SUBREDDIT,
      postedAt: { gte: since },
    },
    orderBy: { postedAt: "desc" },
    select: { externalId: true, title: true, postedAt: true, fetchedAt: true },
  });
  if (!row) return null;

  return {
    postId: row.externalId,
    title: row.title ?? "",
    createdAt: (row.postedAt ?? row.fetchedAt).toISOString(),
  };
}

/**
 * THE GLOBAL FEED — every tracked community, posts and comments interleaved.
 *
 * Reads the same worker-written tables as the per-ticker feed, so opening the
 * page costs no upstream request however many people have it open.
 *
 * `stance` is the sentiment column: it is the classifier's read of the author's
 * position, which is what the badges show. `sentiment` (positive/negative) is a
 * different axis and is deliberately not what this filter uses.
 */
export async function readGlobalDiscussion(
  query: GlobalDiscussionQuery = {},
): Promise<GlobalDiscussionResult> {
  const contentType: ContentType = query.contentType ?? "all";
  const sentiment: SentimentFilter = query.sentiment ?? "all";
  const sort: DiscussionSort = query.sort ?? "newest";
  const limit = Math.min(MAX_FEED_LIMIT, Math.max(1, query.limit ?? DEFAULT_FEED_LIMIT));
  const term = query.search?.trim() || undefined;

  // DAILY DISCUSSION resolves to one thread, then to that thread's comments.
  // Everything below treats it as "comments, with an extra WHERE" — the filter
  // is applied in SQL, so ordering, counts and any future pagination stay
  // correct instead of being trimmed from an already-fetched page.
  const dailyMode = contentType === "daily_discussion";
  // Resolved once for BOTH jobs: it scopes the feed in daily mode, and it is
  // always reported as `sourceThread` so the compact source line renders over
  // any filter. One indexed query either way.
  const latestDaily = await findLatestDailyDiscussionThread();
  const dailyThread = dailyMode ? latestDaily : null;

  const base = {
    // The community picker is ignored in daily mode: the thread IS the scope,
    // and honouring both would silently return nothing whenever the reader had
    // any other subreddit selected.
    ...(!dailyMode && query.subreddits && query.subreddits.length > 0
      ? { subreddit: { in: query.subreddits } }
      : {}),
    ...(sentiment !== "all" ? { stance: sentiment } : {}),
    ...(query.from || query.to
      ? {
          postedAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  };

  // Daily mode returns comments only — the container post is never a row in
  // the feed, and the POSTS filter has no meaning here.
  const wantPosts = contentType === "all" || contentType === "post";
  const wantComments = contentType === "all" || contentType === "comment" || dailyMode;

  // The filter is on but nothing was indexed inside the window: return an empty
  // feed and say which thread is missing, rather than showing unrelated rows.
  if (dailyMode && !dailyThread) {
    return {
      items: [],
      meta: {
        contentType,
        sentiment,
        sort,
        subreddits: null,
        from: query.from?.toISOString() ?? null,
        to: query.to?.toISOString() ?? null,
        search: term ?? null,
        postCount: 0,
        commentCount: 0,
        providers: [],
        isMock: false,
        latestAt: null,
        dailyDiscussion: null,
        sourceThread: latestDaily,
      },
    };
  }

  const [postRows, commentRows] = await Promise.all([
    wantPosts
      ? prisma.socialPosts.findMany({
          where: term ? { AND: [base, postSearch(term)] } : base,
          orderBy: postOrder(sort),
          take: limit,
        })
      : Promise.resolve([]),
    wantComments
      ? prisma.socialComments.findMany({
          where: (() => {
            // The parent link is what makes this a real relation rather than a
            // title heuristic: only comments whose stored parent IS the
            // resolved thread are returned.
            const scoped = dailyThread
              ? { AND: [base, { postExternalId: dailyThread.postId }] }
              : base;
            return term ? { AND: [scoped, commentSearch(term)] } : scoped;
          })(),
          // Comments carry no comment-count; upvote sort still applies.
          orderBy: sort === "upvotes" ? [{ score: "desc" }, { postedAt: "desc" }] : [{ postedAt: "desc" }],
          take: limit,
        })
      : Promise.resolve([]),
  ]);

  // A ticker is needed to shape an item; the first tagged symbol is the one the
  // card links to, and an untagged item keeps an empty symbol rather than being
  // dropped — it is still discussion.
  const primary = (tickers: string[] | null) => tickers?.[0]?.toUpperCase() ?? "";

  // Two queries for the whole page, not one per card. Only associations at or
  // above the display threshold come back — the filter is in SQL, so a weak
  // match cannot reach a response by being forgotten in a later branch.
  const [postBadges, commentBadges] = await Promise.all([
    badgesForPosts(postRows.map((r) => r.id), DISPLAY_THRESHOLD),
    badgesForComments(commentRows.map((r) => r.id), DISPLAY_THRESHOLD),
  ]);

  const items: FeedItem[] = [
    ...postRows.map((r) => ({
      kind: "post" as const,
      ...normalizePost(r, primary(r.tickers), postBadges.get(r.id) ?? []),
    })),
    ...commentRows.map((r) => ({
      kind: "comment" as const,
      ...normalizeComment(r, primary(r.tickers), commentBadges.get(r.id) ?? []),
    })),
  ];

  // Posts and comments are fetched separately, so the merged list is re-sorted
  // once here rather than trusting two independent orderings.
  items.sort((a, b) => {
    if (sort === "upvotes") {
      const av = (a.kind === "post" ? a.upvotes : a.score) ?? -1;
      const bv = (b.kind === "post" ? b.upvotes : b.score) ?? -1;
      if (av !== bv) return bv - av;
    }
    if (sort === "comments") {
      const av = a.kind === "post" ? (a.commentCount ?? -1) : -1;
      const bv = b.kind === "post" ? (b.commentCount ?? -1) : -1;
      if (av !== bv) return bv - av;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });

  const trimmed = items.slice(0, limit);
  const providers = [
    ...new Set(
      [...postRows, ...commentRows].map((r) => r.provider).filter((p): p is string => Boolean(p)),
    ),
  ];
  const instants = trimmed.map((i) => i.createdAt).sort();

  return {
    items: trimmed,
    meta: {
      contentType,
      sentiment,
      sort,
      subreddits: dailyMode
        ? [DAILY_DISCUSSION_SUBREDDIT]
        : query.subreddits && query.subreddits.length > 0
          ? query.subreddits
          : null,
      from: query.from?.toISOString() ?? null,
      to: query.to?.toISOString() ?? null,
      search: term ?? null,
      postCount: trimmed.filter((i) => i.kind === "post").length,
      commentCount: trimmed.filter((i) => i.kind === "comment").length,
      providers,
      isMock: providers.length > 0 && providers.every((p) => p === "mock"),
      latestAt: instants.length > 0 ? instants[instants.length - 1] : null,
      ...(dailyMode ? { dailyDiscussion: dailyThread } : {}),
      sourceThread: latestDaily,
    },
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

  // The per-ticker tab gets the same badges as the global feed — a post about
  // NVDA and AMD shows both there too, not just the symbol whose page you are on.
  const [postBadges, commentBadges] = await Promise.all([
    badgesForPosts(postRows.map((r) => r.id), DISPLAY_THRESHOLD),
    badgesForComments(commentRows.map((r) => r.id), DISPLAY_THRESHOLD),
  ]);

  const posts = postRows.map((r) => normalizePost(r, symbol, postBadges.get(r.id) ?? []));
  const comments = commentRows.map((r) =>
    normalizeComment(r, symbol, commentBadges.get(r.id) ?? []),
  );

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
