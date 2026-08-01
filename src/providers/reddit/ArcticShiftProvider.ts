import { assertProviderCallsAllowed } from "../../config/serviceRole.js";
import type { ArcticShiftConfig, RedditDataConfig } from "../../config/redditDataConfig.js";
import { requestJson, sleep } from "./httpClient.js";
import {
  normalizeArcticShiftComment,
  normalizeArcticShiftPost,
  normalizeComments,
  normalizePosts,
  toFullname,
} from "./normalizeRedditData.js";
import { RedditProviderError } from "./providerErrors.js";
import { trackProviderCall } from "./providerHealth.js";
import type { RedditDataProvider } from "./RedditDataProvider.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
  RedditFetchCommentsInput,
  RedditFetchPostsInput,
} from "./types.js";

/**
 * Arctic Shift (https://arctic-shift.photon-reddit.com) — a public Reddit
 * archive with Pushshift-style search endpoints.
 *
 *   GET /api/posts/search?subreddit=&after=&before=&limit=&sort=
 *   GET /api/comments/search?subreddit=&link_id=&after=&before=&limit=&sort=
 *
 * Both answer `{ "data": [ …reddit-shaped records… ] }`.
 *
 * CHARACTERISTICS THAT SHAPE THIS CODE
 *  - No API key, no auth. It is therefore the safe default provider.
 *  - It is a free community service: every request is spaced by
 *    ARCTIC_SHIFT_REQUEST_DELAY_MS and pages are capped, so a large backfill
 *    cannot turn into a hammering loop.
 *  - It is an ARCHIVE, so there is no "hot" ranking. `sort: "hot"` is served as
 *    newest-first and `sort: "top"` is ranked locally by score after fetching.
 *  - Pagination is by timestamp, not by cursor, so boundary records can repeat
 *    between pages. Ids already seen are skipped and a page that adds nothing
 *    new ends the loop.
 *
 * Nothing outside this file knows any of the above.
 */

const POSTS_PATH = "/api/posts/search";
const COMMENTS_PATH = "/api/comments/search";
/** Arctic Shift caps a single search response at 100 records. */
const PAGE_SIZE = 100;
/** Hard ceiling on requests per fetch call — a runaway paginator backstop. */
const MAX_PAGES = 20;
const DEFAULT_LIMIT = 100;

interface ArcticShiftResponse {
  data?: unknown;
}

/** One page of posts, plus what the caller needs to decide what happens next. */
export interface ArcticShiftPage {
  posts: NormalizedRedditPost[];
  /** Records the upstream returned, before normalization dropped any. */
  receivedCount: number;
  /** The response filled the page — the window probably holds more. */
  hasMore: boolean;
  /** Window actually requested, for the log line and the metrics row. */
  after: Date | undefined;
  before: Date | undefined;
  limit: number;
}

export interface ArcticShiftPageInput {
  subreddit: string;
  after?: Date;
  before?: Date;
  limit?: number;
  /** `asc` walks the window oldest-first, which is what incremental sync wants. */
  sort?: "asc" | "desc";
  /** Per-attempt abort. Overrides the shared provider timeout. */
  timeoutMs?: number;
}

export class ArcticShiftProvider implements RedditDataProvider {
  readonly name = "arctic_shift" as const;

  private readonly settings: ArcticShiftConfig;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(config: RedditDataConfig) {
    this.settings = config.arcticShift;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
    this.retryDelayMs = config.retryDelayMs;
  }

  /** Keyless: available whenever a base URL is configured (always, by default). */
  isAvailable(): boolean {
    return Boolean(this.settings.baseUrl);
  }

  async fetchPosts(input: RedditFetchPostsInput): Promise<NormalizedRedditPost[]> {
    assertProviderCallsAllowed("Arctic Shift");
    const subreddit = cleanSubreddit(input.subreddit);
    if (!subreddit) {
      throw new RedditProviderError(
        this.name,
        "client",
        "fetchPosts requires a subreddit.",
      );
    }

    const limit = clampLimit(input.limit);
    console.log(
      `[ArcticShiftProvider] Fetching posts subreddit=${subreddit} limit=${limit}` +
        (input.query ? ` query=set` : ""),
    );

    const fetchedAt = new Date();
    const collected = await trackProviderCall(this.name, () =>
      this.paginate({
        path: POSTS_PATH,
        limit,
        params: {
          subreddit,
          ...(input.query ? { query: input.query } : {}),
        },
        after: input.after,
        before: input.before,
      }),
    );

    const posts = normalizePosts(collected, normalizeArcticShiftPost, {
      subreddit,
      fetchedAt,
    });

    console.log(
      `[ArcticShiftProvider] Fetched ${posts.length} posts subreddit=${subreddit}`,
    );

    return applyPostSort(posts, input.sort).slice(0, limit);
  }

  /**
   * ONE request. No pagination, no retries, no backoff sleep.
   *
   * `fetchPosts` above is the general-purpose path: it pages until it has what
   * the caller asked for, and the HTTP client retries transient failures. The
   * scheduled worker cannot use it, because "one request every five minutes"
   * has to mean one HTTP request — a paginating call that also retries can
   * legitimately produce twenty. This method is the primitive that keeps that
   * promise: exactly one GET, whatever happens.
   *
   * Failures are thrown as `RedditProviderError` (rate_limit carries
   * `retryAfterSeconds`), because the WORKER decides what a failure means —
   * waiting for its next slot, never an immediate second attempt.
   */
  async fetchPostsPage(input: ArcticShiftPageInput): Promise<ArcticShiftPage> {
    assertProviderCallsAllowed("Arctic Shift");

    const subreddit = cleanSubreddit(input.subreddit);
    if (!subreddit) {
      throw new RedditProviderError(
        this.name,
        "client",
        "fetchPostsPage requires a subreddit.",
      );
    }

    const limit = Math.max(1, Math.min(PAGE_SIZE, Math.trunc(input.limit ?? PAGE_SIZE)));
    const sort = input.sort ?? "asc";
    const url = this.buildUrl(POSTS_PATH, {
      subreddit,
      limit: String(limit),
      sort,
      ...(input.after ? { after: toEpochSeconds(input.after) } : {}),
      ...(input.before ? { before: toEpochSeconds(input.before) } : {}),
    });

    const fetchedAt = new Date();
    const response = await trackProviderCall(this.name, () =>
      requestJson<ArcticShiftResponse>({
        provider: this.name,
        url,
        timeoutMs: input.timeoutMs ?? this.timeoutMs,
        // The two lines that make this single-request: no retries, and
        // therefore no backoff sleep between attempts that do not exist.
        maxRetries: 0,
        retryDelayMs: 0,
        label: POSTS_PATH,
      }),
    );

    const records = extractRecords(response);
    const posts = normalizePosts(records, normalizeArcticShiftPost, {
      subreddit,
      fetchedAt,
    });

    return {
      posts,
      receivedCount: records.length,
      // A full page means the window was truncated. The worker resumes from the
      // last stored post on this subreddit's NEXT turn — never immediately.
      hasMore: records.length >= limit,
      after: input.after,
      before: input.before,
      limit,
    };
  }

  async fetchComments(
    input: RedditFetchCommentsInput,
  ): Promise<NormalizedRedditComment[]> {
    assertProviderCallsAllowed("Arctic Shift");
    const subreddit = cleanSubreddit(input.subreddit ?? "");
    const linkId = toFullname(input.postId ?? postIdFromUrl(input.postUrl), "t3");

    if (!linkId && !subreddit) {
      throw new RedditProviderError(
        this.name,
        "client",
        "fetchComments requires a postId, a postUrl or a subreddit.",
      );
    }

    const limit = clampLimit(input.limit);
    console.log(
      `[ArcticShiftProvider] Fetching comments ${
        linkId ? `link_id=${linkId}` : `subreddit=${subreddit}`
      } limit=${limit}`,
    );

    const fetchedAt = new Date();
    const collected = await trackProviderCall(this.name, () =>
      this.paginate({
        path: COMMENTS_PATH,
        limit,
        params: {
          ...(linkId ? { link_id: linkId } : {}),
          ...(subreddit ? { subreddit } : {}),
        },
        after: input.after,
        before: input.before,
      }),
    );

    const comments = normalizeComments(collected, normalizeArcticShiftComment, {
      ...(subreddit ? { subreddit } : {}),
      fetchedAt,
    });

    console.log(`[ArcticShiftProvider] Fetched ${comments.length} comments`);
    return comments.slice(0, limit);
  }

  /**
   * Page through a search endpoint until `limit` records are collected, the
   * upstream runs out, or MAX_PAGES is reached.
   *
   * Paging walks BACKWARDS in time (`sort=desc`, then `before` = the oldest
   * timestamp seen), which is the shape the ingestion worker wants: newest
   * first, stopping as soon as it reaches content it already has.
   */
  private async paginate(options: {
    path: string;
    limit: number;
    params: Record<string, string>;
    after?: Date;
    before?: Date;
  }): Promise<unknown[]> {
    const { path, limit, params, after } = options;
    const collected: unknown[] = [];
    const seen = new Set<string>();
    let before = options.before;

    for (let page = 0; page < MAX_PAGES && collected.length < limit; page += 1) {
      // Space out requests — the ONLY politeness mechanism this API has.
      if (page > 0 && this.settings.requestDelayMs > 0) {
        await sleep(this.settings.requestDelayMs);
      }

      const url = this.buildUrl(path, {
        ...params,
        limit: String(Math.min(PAGE_SIZE, limit - collected.length)),
        sort: "desc",
        ...(after ? { after: toEpochSeconds(after) } : {}),
        ...(before ? { before: toEpochSeconds(before) } : {}),
      });

      const response = await requestJson<ArcticShiftResponse>({
        provider: this.name,
        url,
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        retryDelayMs: this.retryDelayMs,
        label: path,
      });

      const records = extractRecords(response);
      if (records.length === 0) break;

      let added = 0;
      let oldestSeconds: number | undefined;

      for (const record of records) {
        const id = recordId(record);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        collected.push(record);
        added += 1;

        const created = recordCreatedSeconds(record);
        if (created !== undefined && (oldestSeconds === undefined || created < oldestSeconds)) {
          oldestSeconds = created;
        }
      }

      // Nothing new, or the upstream returned a short page: we are done.
      if (added === 0 || records.length < PAGE_SIZE) break;
      if (oldestSeconds === undefined) break;

      // Step the window back by one second past the oldest record so the same
      // boundary record is not returned again forever.
      before = new Date((oldestSeconds - 1) * 1000);
      if (after && before.getTime() <= after.getTime()) break;
    }

    return collected;
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${this.settings.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== "") url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function cleanSubreddit(value: string): string {
  return value.replace(/^\/?r\//i, "").trim();
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(2_000, Math.trunc(limit)));
}

function toEpochSeconds(date: Date): string {
  return String(Math.floor(date.getTime() / 1000));
}

/** `{ data: [...] }` is the documented shape; a bare array is tolerated. */
function extractRecords(response: ArcticShiftResponse | unknown[]): unknown[] {
  if (Array.isArray(response)) return response;
  const data = (response as ArcticShiftResponse)?.data;
  return Array.isArray(data) ? data : [];
}

function recordId(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>).id;
  return typeof value === "string" ? value : undefined;
}

function recordCreatedSeconds(record: unknown): number | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>).created_utc;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Archive endpoints only order by time, so `top` is ranked here. `hot` has no
 * archive equivalent and is served as newest-first.
 */
function applyPostSort(
  posts: NormalizedRedditPost[],
  sort: RedditFetchPostsInput["sort"],
): NormalizedRedditPost[] {
  if (sort === "top") return [...posts].sort((a, b) => b.score - a.score);
  return [...posts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Pull the post id out of a reddit permalink, e.g. /r/x/comments/abc123/title/. */
function postIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /\/comments\/([a-z0-9]+)/i.exec(url);
  return match?.[1];
}
