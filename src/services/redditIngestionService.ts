import { getRedditDataConfig } from "../config/redditDataConfig.js";
import { sanitizeProviderError } from "../providers/reddit/providerErrors.js";
import { getRedditDataProvider } from "../providers/reddit/RedditProviderFactory.js";
import type { RedditDataProvider } from "../providers/reddit/RedditDataProvider.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
} from "../providers/reddit/types.js";
import {
  latestPostTimestamp,
  saveRedditComments,
  saveRedditPosts,
  type SaveResult,
} from "../repositories/redditContent.repository.js";
import { extractTickersFrom } from "./social/tickerExtractor.service.js";
import { redditConfig } from "../config/reddit.config.js";

/**
 * Reddit ingestion — fetch, detect tickers, persist.
 *
 * THIS SERVICE KNOWS NOTHING ABOUT ANY UPSTREAM. It imports
 * `getRedditDataProvider()` and nothing else from the provider layer: no
 * Mindcase client, no Arctic Shift endpoint, no provider-specific payload
 * shape. Which upstream actually runs — one, both, or one-with-fallback — is
 * decided entirely by REDDIT_DATA_MODE.
 *
 * FAILURE POLICY: one subreddit failing never fails the run. Failures are
 * collected and reported, partial results are saved, and the previous data
 * stays in place — so the dashboard keeps serving the last good snapshot even
 * when every provider is down.
 */

export interface PersistPostsResult {
  insertedCount: number;
  updatedCount: number;
  failedCount: number;
}

/**
 * Persist normalized posts — the ONE way anything writes Reddit content.
 *
 * Both the scheduled worker and the internal scanner page (`persist=true`) call
 * this, so the upsert contract is defined once: keyed on the Reddit id, never
 * duplicating, never overwriting a stored body with null, accumulating
 * `sources`, refreshing `lastSeenAt`. Ticker detection runs here too, so a post
 * saved from the test page is indexed exactly like one saved by the worker.
 */
export async function persistPosts(
  posts: NormalizedRedditPost[],
  options: { storeRawData?: boolean } = {},
): Promise<PersistPostsResult> {
  if (posts.length === 0) {
    return { insertedCount: 0, updatedCount: 0, failedCount: 0 };
  }

  const config = getRedditDataConfig();
  const tickersByPost = detectTickers(posts).tickersByPost;

  const result = await saveRedditPosts(posts, {
    storeRawData: options.storeRawData ?? config.storeSourceMetadata,
    tickersByPost,
  });

  return {
    insertedCount: result.created,
    updatedCount: result.updated,
    failedCount: result.failed,
  };
}

/** Cashtags / allowlisted symbols per post, plus the total detected. */
function detectTickers(posts: NormalizedRedditPost[]): {
  tickersByPost: Map<string, string[]>;
  total: number;
} {
  const tickersByPost = new Map<string, string[]>();
  let total = 0;
  for (const post of posts) {
    const tickers = extractTickersFrom(post.title, post.body);
    if (tickers.length > 0) {
      tickersByPost.set(post.externalId, tickers);
      total += tickers.length;
    }
  }
  return { tickersByPost, total };
}

/** How far back to look on the very first run for a subreddit. */
const COLD_START_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Re-fetch a little before the newest stored post so nothing slips the gap. */
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

export interface IngestPostsOptions {
  /** Defaults to `REDDIT_SUBREDDITS` — never a list written in this file. */
  subreddits?: readonly string[];
  /** Posts requested per subreddit. */
  limit?: number;
  /**
   * Ignore the stored watermark and fetch this window instead. Used by manual
   * backfills; the scheduled job always uses the watermark.
   */
  since?: Date;
  /** Also ingest comments for the posts fetched. Off by default (quota). */
  includeComments?: boolean;
  /** Cap on how many posts get their comments fetched in one run. */
  commentPostLimit?: number;
  /** Injectable for tests; defaults to the configured singleton. */
  provider?: RedditDataProvider;
}

export interface IngestionSummary {
  provider: string;
  mode: string;
  subredditsAttempted: number;
  subredditsFailed: string[];
  postsFetched: number;
  posts: SaveResult;
  commentsFetched: number;
  comments: SaveResult;
  tickersDetected: number;
}

/**
 * Ingest recent posts for every tracked subreddit.
 *
 * Subreddits are processed SEQUENTIALLY on purpose: both upstreams are metered
 * (Mindcase bills per job, Arctic Shift is a free community service), and the
 * providers already handle their own retry/pacing internally. Fanning out here
 * would defeat both.
 */
export async function ingestRedditPosts(
  options: IngestPostsOptions = {},
): Promise<IngestionSummary> {
  const config = getRedditDataConfig();
  const provider = options.provider ?? getRedditDataProvider();
  // One list for every provider — Arctic Shift, Mindcase, hybrid, fallback.
  const subreddits = options.subreddits ?? redditConfig.subreddits;
  const limit = options.limit ?? 200;

  const failed: string[] = [];
  const allPosts: NormalizedRedditPost[] = [];

  for (const subreddit of subreddits) {
    try {
      const after = options.since ?? (await watermarkFor(subreddit));
      const posts = await provider.fetchPosts({
        subreddit,
        after,
        limit,
        sort: "new",
      });
      allPosts.push(...posts);
    } catch (error) {
      failed.push(subreddit);
      console.error(
        `[redditIngestion] ${subreddit} failed: ${sanitizeProviderError(error)}`,
      );
    }
  }

  // Detect tickers before writing so mentions and posts land in one pass.
  const { tickersByPost, total: tickersDetected } = detectTickers(allPosts);

  const postResult = await saveRedditPosts(allPosts, {
    storeRawData: config.storeSourceMetadata,
    tickersByPost,
  });

  let commentsFetched = 0;
  let commentResult: SaveResult = { created: 0, updated: 0, failed: 0 };

  if (options.includeComments && allPosts.length > 0) {
    const outcome = await ingestCommentsForPosts(
      allPosts.slice(0, options.commentPostLimit ?? 25),
      provider,
      config.storeSourceMetadata,
    );
    commentsFetched = outcome.fetched;
    commentResult = outcome.saved;
  }

  return {
    provider: provider.name,
    mode: config.mode,
    subredditsAttempted: subreddits.length,
    subredditsFailed: failed,
    postsFetched: allPosts.length,
    posts: postResult,
    commentsFetched,
    comments: commentResult,
    tickersDetected,
  };
}

/**
 * Fetch and store the comments of specific posts.
 *
 * Comments are OPT-IN because they multiply provider cost by the number of
 * posts. A post whose comments fail is skipped; the rest still land.
 */
async function ingestCommentsForPosts(
  posts: NormalizedRedditPost[],
  provider: RedditDataProvider,
  storeRawData: boolean,
): Promise<{ fetched: number; saved: SaveResult }> {
  const collected: NormalizedRedditComment[] = [];

  for (const post of posts) {
    try {
      const comments = await provider.fetchComments({
        postId: post.externalId,
        subreddit: post.subreddit,
        limit: 200,
      });
      // A provider that could not attribute the parent still gets it right
      // here: we know exactly which post we asked about.
      collected.push(
        ...comments.map((comment) =>
          comment.postId ? comment : { ...comment, postId: post.externalId },
        ),
      );
    } catch (error) {
      console.error(
        `[redditIngestion] comments for ${post.externalId} failed: ${sanitizeProviderError(error)}`,
      );
    }
  }

  const saved = await saveRedditComments(collected, { storeRawData });
  return { fetched: collected.length, saved };
}

/**
 * Where to resume fetching a subreddit.
 *
 * The newest stored post minus a small overlap, so a post created while the
 * previous run was in flight is not missed. With nothing stored yet, a bounded
 * cold-start window — never "everything ever posted".
 */
async function watermarkFor(subreddit: string): Promise<Date> {
  const latest = await latestPostTimestamp(subreddit);
  if (!latest) return new Date(Date.now() - COLD_START_WINDOW_MS);
  return new Date(latest.getTime() - WATERMARK_OVERLAP_MS);
}
