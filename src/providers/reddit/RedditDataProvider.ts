import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
  RedditFetchCommentsInput,
  RedditFetchPostsInput,
  RedditProviderName,
} from "./types.js";

/**
 * The ONLY contract the rest of the application knows about Reddit data.
 *
 * Every implementation — a real upstream (Mindcase, Arctic Shift) or a
 * composite (hybrid, fallback) — satisfies exactly this interface, so the
 * ingestion service is written against one type and the choice of upstream is
 * a `.env` value rather than a code change.
 *
 * Implementations must:
 *   - return normalized records only (never upstream-shaped payloads);
 *   - throw `RedditProviderError` (see providerErrors.ts) so composites can
 *     tell a retryable outage from a bad request;
 *   - never log credentials.
 */
export interface RedditDataProvider {
  readonly name: RedditProviderName;

  /**
   * Whether this provider could serve a request right now — configuration
   * only (credentials present, base URL set). It performs no network I/O.
   */
  isAvailable(): boolean;

  fetchPosts(input: RedditFetchPostsInput): Promise<NormalizedRedditPost[]>;

  fetchComments(
    input: RedditFetchCommentsInput,
  ): Promise<NormalizedRedditComment[]>;
}
