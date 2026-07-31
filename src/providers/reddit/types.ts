/**
 * Canonical shapes for Reddit content, independent of who supplied it.
 *
 * Nothing outside `src/providers/reddit/` ever sees a Mindcase job payload or an
 * Arctic Shift search response: every provider normalizes into the types below,
 * so services, repositories and routes are written once and keep working when
 * the upstream changes.
 */

export type RedditProviderName = "mindcase" | "arctic_shift";

export type RedditDataMode =
  | "mindcase"
  | "arctic_shift"
  | "hybrid"
  | "fallback";

export type RedditContentType = "post" | "comment";

export interface RedditFetchPostsInput {
  subreddit: string;
  query?: string;
  after?: Date;
  before?: Date;
  limit?: number;
  sort?: "new" | "hot" | "top";
}

export interface RedditFetchCommentsInput {
  postId?: string;
  postUrl?: string;
  subreddit?: string;
  after?: Date;
  before?: Date;
  limit?: number;
}

export interface NormalizedRedditPost {
  /** Reddit id WITHOUT the `t3_` prefix — the deduplication key. */
  externalId: string;
  /** Reddit fullname (`t3_<id>`) when known. */
  fullname: string | null;
  subreddit: string;
  /**
   * Raw author name as the upstream reported it, or null for
   * deleted/removed/anonymous authors.
   *
   * PRIVACY: this value is never persisted or exposed as-is. The repository
   * layer stores a one-way hash (`author_hash`) and the public API only ever
   * serves that hash — see repositories/redditContent.repository.ts.
   */
  author: string | null;

  title: string;
  body: string | null;

  permalink: string;
  url: string | null;

  score: number;
  upvoteRatio: number | null;
  commentCount: number;

  createdAt: Date;
  fetchedAt: Date;

  primarySource: RedditProviderName;
  sources: RedditProviderName[];

  raw?: unknown;
}

export interface NormalizedRedditComment {
  /** Reddit id WITHOUT the `t1_` prefix — the deduplication key. */
  externalId: string;
  /** Reddit fullname (`t1_<id>`) when known. */
  fullname: string | null;
  /** Parent post id, normalized the same way as a post's `externalId`. */
  postId: string;
  /**
   * Parent fullname (`t1_…` for a reply, `t3_…` for a top-level comment). Kept
   * in fullname form because the prefix is the only thing that says whether the
   * parent is a comment or the post itself.
   */
  parentId: string | null;

  subreddit: string;
  /** See the privacy note on `NormalizedRedditPost.author`. */
  author: string | null;
  body: string | null;

  permalink: string | null;
  score: number;

  createdAt: Date;
  fetchedAt: Date;

  primarySource: RedditProviderName;
  sources: RedditProviderName[];

  raw?: unknown;
}

/** Health of one provider, as observed by the calls this process has made. */
export type RedditProviderStatus = "healthy" | "degraded" | "unavailable";

export interface RedditProviderHealth {
  provider: RedditProviderName;
  status: RedditProviderStatus;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  /** Sanitized message — never contains credentials. */
  lastError: string | null;
  averageResponseTimeMs: number | null;
}
