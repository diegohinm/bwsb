import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
  RedditProviderName,
} from "./types.js";

/**
 * Merge records that two providers returned for the same piece of Reddit
 * content.
 *
 * The key is `externalId` — the prefix-free Reddit id that
 * normalizeRedditData.ts guarantees. That is what makes hybrid mode safe: the
 * same post fetched from Mindcase and from Arctic Shift collapses into ONE
 * record before it ever reaches the database, so no upsert can create a
 * duplicate row.
 *
 * MERGE RULES (in the order they are applied)
 *  1. `sources` is the union of both records' sources.
 *  2. `primarySource` is the configured primary provider when it contributed;
 *     otherwise the first record's own primary source.
 *  3. CONTENT (title, body, permalink, url, author, …) — the most complete
 *     value wins: a non-null beats a null, and between two non-nulls the longer
 *     text wins. A provider that returns a truncated preview can never erase a
 *     full DD post that the other one captured.
 *  4. VOLATILE METRICS (score, commentCount, upvoteRatio) come from the FRESHER
 *     record: newest `fetchedAt` first, ties broken by completeness. Scores move
 *     both ways, so "most recent" is the only correct rule — never "highest".
 *  5. `createdAt` is the earliest observed value; a post's creation time does
 *     not change, and the earliest is the least likely to be a re-derived
 *     approximation.
 */

export interface DeduplicateOptions {
  /**
   * Provider whose name should win the `primarySource` slot on merged records.
   * Normally `REDDIT_PRIMARY_PROVIDER`.
   */
  preferredSource?: RedditProviderName;
}

/** How much usable content a record carries — the tie-breaker for rule 4. */
function postCompleteness(post: NormalizedRedditPost): number {
  return (
    (post.body?.length ?? 0) +
    (post.title.length > 0 ? post.title.length : 0) +
    (post.url ? 1 : 0) +
    (post.author ? 1 : 0) +
    (post.upvoteRatio !== null ? 1 : 0)
  );
}

function commentCompleteness(comment: NormalizedRedditComment): number {
  return (
    (comment.body?.length ?? 0) +
    (comment.permalink ? 1 : 0) +
    (comment.author ? 1 : 0) +
    (comment.parentId ? 1 : 0)
  );
}

/** The non-null value, or the longer one when both are present. */
function richerText(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.length > a.length ? b : a;
}

function richerRequiredText(a: string, b: string): string {
  return b.length > a.length ? b : a;
}

function mergeSources(
  a: RedditProviderName[],
  b: RedditProviderName[],
  preferred?: RedditProviderName,
): RedditProviderName[] {
  const union = [...new Set([...a, ...b])];
  if (!preferred || !union.includes(preferred)) return union;
  // Preferred provider first so the array reads as "primary, then the rest".
  return [preferred, ...union.filter((name) => name !== preferred)];
}

function mergePrimarySource(
  existing: RedditProviderName,
  incoming: RedditProviderName,
  sources: RedditProviderName[],
  preferred?: RedditProviderName,
): RedditProviderName {
  if (preferred && sources.includes(preferred)) return preferred;
  return existing ?? incoming;
}

/** True when `incoming` should supply the volatile metrics (rule 4). */
function incomingIsFresher(
  existingFetchedAt: Date,
  incomingFetchedAt: Date,
  existingCompleteness: number,
  incomingCompleteness: number,
): boolean {
  const existingTime = existingFetchedAt.getTime();
  const incomingTime = incomingFetchedAt.getTime();
  if (incomingTime !== existingTime) return incomingTime > existingTime;
  // Same instant (the common case within one hybrid sweep): prefer the record
  // that carried more content — it is the one that actually looked at the post.
  return incomingCompleteness > existingCompleteness;
}

/** Merge two normalized views of the SAME post. */
export function mergeRedditPosts(
  existing: NormalizedRedditPost,
  incoming: NormalizedRedditPost,
  preferred?: RedditProviderName,
): NormalizedRedditPost {
  const sources = mergeSources(existing.sources, incoming.sources, preferred);
  const useIncomingMetrics = incomingIsFresher(
    existing.fetchedAt,
    incoming.fetchedAt,
    postCompleteness(existing),
    postCompleteness(incoming),
  );
  const fresher = useIncomingMetrics ? incoming : existing;
  const staler = useIncomingMetrics ? existing : incoming;

  return {
    externalId: existing.externalId,
    fullname: existing.fullname ?? incoming.fullname,
    subreddit: existing.subreddit || incoming.subreddit,
    author: existing.author ?? incoming.author,

    title: richerRequiredText(existing.title, incoming.title),
    body: richerText(existing.body, incoming.body),

    permalink: richerRequiredText(existing.permalink, incoming.permalink),
    url: existing.url ?? incoming.url,

    score: fresher.score,
    upvoteRatio: fresher.upvoteRatio ?? staler.upvoteRatio,
    commentCount: fresher.commentCount,

    createdAt:
      existing.createdAt.getTime() <= incoming.createdAt.getTime()
        ? existing.createdAt
        : incoming.createdAt,
    fetchedAt: fresher.fetchedAt,

    primarySource: mergePrimarySource(
      existing.primarySource,
      incoming.primarySource,
      sources,
      preferred,
    ),
    sources,

    ...(fresher.raw !== undefined || staler.raw !== undefined
      ? { raw: fresher.raw ?? staler.raw }
      : {}),
  };
}

/** Merge two normalized views of the SAME comment. */
export function mergeRedditComments(
  existing: NormalizedRedditComment,
  incoming: NormalizedRedditComment,
  preferred?: RedditProviderName,
): NormalizedRedditComment {
  const sources = mergeSources(existing.sources, incoming.sources, preferred);
  const useIncomingMetrics = incomingIsFresher(
    existing.fetchedAt,
    incoming.fetchedAt,
    commentCompleteness(existing),
    commentCompleteness(incoming),
  );
  const fresher = useIncomingMetrics ? incoming : existing;
  const staler = useIncomingMetrics ? existing : incoming;

  return {
    externalId: existing.externalId,
    fullname: existing.fullname ?? incoming.fullname,
    postId: existing.postId || incoming.postId,
    parentId: existing.parentId ?? incoming.parentId,

    subreddit: existing.subreddit || incoming.subreddit,
    author: existing.author ?? incoming.author,
    body: richerText(existing.body, incoming.body),

    permalink: richerText(existing.permalink, incoming.permalink),
    score: fresher.score,

    createdAt:
      existing.createdAt.getTime() <= incoming.createdAt.getTime()
        ? existing.createdAt
        : incoming.createdAt,
    fetchedAt: fresher.fetchedAt,

    primarySource: mergePrimarySource(
      existing.primarySource,
      incoming.primarySource,
      sources,
      preferred,
    ),
    sources,

    ...(fresher.raw !== undefined || staler.raw !== undefined
      ? { raw: fresher.raw ?? staler.raw }
      : {}),
  };
}

/**
 * Collapse duplicate posts by `externalId`, preserving input order (the first
 * time an id appears decides where the merged record sits).
 */
export function deduplicatePosts(
  posts: NormalizedRedditPost[],
  options: DeduplicateOptions = {},
): NormalizedRedditPost[] {
  const byId = new Map<string, NormalizedRedditPost>();

  for (const post of posts) {
    const existing = byId.get(post.externalId);
    byId.set(
      post.externalId,
      existing ? mergeRedditPosts(existing, post, options.preferredSource) : post,
    );
  }

  return [...byId.values()];
}

/** Collapse duplicate comments by `externalId`, preserving input order. */
export function deduplicateComments(
  comments: NormalizedRedditComment[],
  options: DeduplicateOptions = {},
): NormalizedRedditComment[] {
  const byId = new Map<string, NormalizedRedditComment>();

  for (const comment of comments) {
    const existing = byId.get(comment.externalId);
    byId.set(
      comment.externalId,
      existing
        ? mergeRedditComments(existing, comment, options.preferredSource)
        : comment,
    );
  }

  return [...byId.values()];
}
