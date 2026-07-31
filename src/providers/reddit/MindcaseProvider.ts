import { assertProviderCallsAllowed } from "../../config/serviceRole.js";
import type { MindcaseConfig, RedditDataConfig } from "../../config/redditDataConfig.js";
import { requestJson, sleep } from "./httpClient.js";
import {
  normalizeComments,
  normalizeMindcaseComment,
  normalizeMindcasePost,
  normalizePosts,
  toBareId,
} from "./normalizeRedditData.js";
import { RedditProviderError } from "./providerErrors.js";
import { recordProviderUnavailable, trackProviderCall } from "./providerHealth.js";
import type { RedditDataProvider } from "./RedditDataProvider.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
  RedditFetchCommentsInput,
  RedditFetchPostsInput,
} from "./types.js";

/**
 * Mindcase (https://mindcase.co) as a `RedditDataProvider`.
 *
 * Mindcase's Reddit skills are ASYNC JOBS, not plain queries:
 *   POST /agents/reddit/posts/run     (Bearer auth) → job id, or inline results
 *   POST /agents/reddit/comments/run  (Bearer auth) → job id, or inline results
 *   GET  /jobs/{id}/results           → poll until the job completes
 *
 * All of that — job creation, polling budget, 429 backoff, the loosely-typed
 * record shapes — is contained here. Callers only ever see normalized posts and
 * comments, exactly like every other provider. No service, route or controller
 * may import this class directly; they go through `RedditProviderFactory`.
 *
 * RELATIONSHIP TO THE EXISTING INTEGRATION
 * `services/social/providers/mindcaseSocialData.provider.ts` still powers the
 * Subreddit Pulse aggregation and is untouched — it produces `SocialPostItem`s
 * for that pipeline. THIS class is the Reddit-shaped path (posts/comments with
 * real Reddit ids) used by the new ingestion worker. Both talk to the same
 * upstream; neither is a wrapper of the other, so the pulse pipeline cannot be
 * broken by changes made here.
 *
 * CREDENTIALS: the API key is read from configuration, sent only in the
 * Authorization header, and never logged — not in an error, not in a URL.
 */

const POSTS_JOB_PATH = "/agents/reddit/posts/run";
const COMMENTS_JOB_PATH = "/agents/reddit/comments/run";
const DEFAULT_LIMIT = 100;
/** Mindcase bills per record; never ask for an unbounded page. */
const MAX_RESULTS = 500;

type MindcaseRecord = Record<string, unknown>;

export class MindcaseProvider implements RedditDataProvider {
  readonly name = "mindcase" as const;

  private readonly settings: MindcaseConfig;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(config: RedditDataConfig) {
    this.settings = config.mindcase;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
    this.retryDelayMs = config.retryDelayMs;

    if (!this.isAvailable()) {
      // Loud but not fatal: hybrid/fallback modes carry on with the other
      // provider, and the app keeps serving whatever is already in Postgres.
      recordProviderUnavailable(
        this.name,
        "MINDCASE_API_KEY is not set — Mindcase cannot be called.",
      );
      console.warn(
        "[MindcaseProvider] MINDCASE_API_KEY is not set — this provider will report itself unavailable.",
      );
    }
  }

  isAvailable(): boolean {
    return Boolean(this.settings.apiKey && this.settings.baseUrl);
  }

  async fetchPosts(input: RedditFetchPostsInput): Promise<NormalizedRedditPost[]> {
    this.assertConfigured();
    assertProviderCallsAllowed("Mindcase");

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
      `[MindcaseProvider] Fetching posts subreddit=${subreddit} limit=${limit}`,
    );

    const fetchedAt = new Date();
    const records = await trackProviderCall(this.name, () =>
      this.runJob(POSTS_JOB_PATH, {
        params: {
          urls: `https://www.reddit.com/r/${subreddit}/`,
          ...(input.query ? { keyword: input.query } : {}),
          ...(input.sort ? { sort: input.sort } : {}),
          maxResults: limit,
        },
      }),
    );

    const posts = normalizePosts(records, normalizeMindcasePost, {
      subreddit,
      fetchedAt,
    });

    const filtered = filterByWindow(posts, input.after, input.before).slice(0, limit);
    console.log(
      `[MindcaseProvider] Fetched ${filtered.length} posts subreddit=${subreddit}`,
    );
    return filtered;
  }

  async fetchComments(
    input: RedditFetchCommentsInput,
  ): Promise<NormalizedRedditComment[]> {
    this.assertConfigured();
    assertProviderCallsAllowed("Mindcase");

    const subreddit = cleanSubreddit(input.subreddit ?? "");
    const postId = toBareId(input.postId ?? null);
    const postUrl =
      input.postUrl ??
      (postId && subreddit
        ? `https://www.reddit.com/r/${subreddit}/comments/${postId}/`
        : undefined);

    if (!postUrl && !subreddit) {
      throw new RedditProviderError(
        this.name,
        "client",
        "fetchComments requires a postUrl, a postId + subreddit, or a subreddit.",
      );
    }

    const limit = clampLimit(input.limit);
    console.log(
      `[MindcaseProvider] Fetching comments ${
        postId ? `postId=${postId}` : `subreddit=${subreddit}`
      } limit=${limit}`,
    );

    const fetchedAt = new Date();
    const records = await trackProviderCall(this.name, () =>
      this.runJob(COMMENTS_JOB_PATH, {
        params: {
          urls: postUrl ?? `https://www.reddit.com/r/${subreddit}/`,
          maxResults: limit,
        },
      }),
    );

    const comments = normalizeComments(records, normalizeMindcaseComment, {
      ...(subreddit ? { subreddit } : {}),
      fetchedAt,
    });

    const filtered = filterByWindow(comments, input.after, input.before)
      .map((comment) =>
        // A comments job scoped to one post knows the parent even when the
        // record omits it.
        comment.postId === "" && postId ? { ...comment, postId } : comment,
      )
      .slice(0, limit);

    console.log(`[MindcaseProvider] Fetched ${filtered.length} comments`);
    return filtered;
  }

  private assertConfigured(): void {
    if (!this.isAvailable()) {
      throw new RedditProviderError(
        this.name,
        "not_configured",
        "Mindcase is not configured (missing MINDCASE_API_KEY or MINDCASE_BASE_URL).",
      );
    }
  }

  /**
   * Start a job and return its records — inline when the API answers
   * immediately, otherwise by polling the job id.
   */
  private async runJob(path: string, body: unknown): Promise<MindcaseRecord[]> {
    const created = await this.request<MindcaseRecord>("POST", path, body);

    const inline = extractRecords(created);
    if (inline.length > 0) {
      console.log(`[MindcaseProvider] Job returned ${inline.length} inline record(s)`);
      return inline;
    }

    const jobId = jobIdOf(created);
    if (!jobId) {
      // No records and no job to poll: the upstream answered with something we
      // cannot act on. Treated as retryable so fallback mode can react.
      throw new RedditProviderError(
        this.name,
        "invalid_response",
        `Mindcase ${path} returned neither results nor a job id.`,
      );
    }

    console.log(`[MindcaseProvider] Job created jobId=${jobId}`);
    return this.pollJob(jobId);
  }

  /**
   * Poll `/jobs/{id}/results` until the job completes or the budget runs out.
   *
   * At most MINDCASE_MAX_POLL_ATTEMPTS polls, each separated by at least
   * MINDCASE_POLL_INTERVAL_MS. Tight polling of this endpoint is precisely what
   * earns a 429, so the sleep is not optional.
   */
  private async pollJob(jobId: string): Promise<MindcaseRecord[]> {
    const maxAttempts = this.settings.maxPollAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.request<MindcaseRecord>(
        "GET",
        `/jobs/${encodeURIComponent(jobId)}/results`,
      );

      const status = statusOf(response);
      const records = extractRecords(response);

      if (records.length > 0 || status === "completed" || status === "succeeded") {
        console.log(
          `[MindcaseProvider] Job complete jobId=${jobId} records=${records.length} polls=${attempt}`,
        );
        return records;
      }

      if (status === "failed" || status === "error") {
        throw new RedditProviderError(
          this.name,
          "server",
          `Mindcase job ${jobId} finished with status "${status}".`,
        );
      }

      // Nothing to wait for after the final attempt.
      if (attempt < maxAttempts) await sleep(this.settings.pollIntervalMs);
    }

    throw new RedditProviderError(
      this.name,
      "job_timeout",
      `Mindcase job ${jobId} did not complete within ${maxAttempts} poll attempt(s).`,
    );
  }

  /** Authenticated JSON request. The Bearer token never leaves this method. */
  private request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    return requestJson<T>({
      provider: this.name,
      url: `${this.settings.baseUrl}${path}`,
      method,
      headers: { Authorization: `Bearer ${this.settings.apiKey}` },
      ...(body !== undefined ? { body } : {}),
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
      label: redactPath(path),
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function cleanSubreddit(value: string): string {
  return value.replace(/^\/?r\//i, "").trim();
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_RESULTS, Math.trunc(limit)));
}

/** Mindcase has no server-side time filter, so the window is applied here. */
function filterByWindow<T extends { createdAt: Date }>(
  records: T[],
  after?: Date,
  before?: Date,
): T[] {
  if (!after && !before) return records;
  return records.filter((record) => {
    const time = record.createdAt.getTime();
    if (after && time < after.getTime()) return false;
    if (before && time > before.getTime()) return false;
    return true;
  });
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function statusOf(payload: MindcaseRecord): string | undefined {
  return str(payload.status)?.toLowerCase();
}

function jobIdOf(payload: MindcaseRecord): string | undefined {
  const nested = payload.data as MindcaseRecord | undefined;
  return (
    str(payload.jobId) ??
    str(payload.job_id) ??
    str(payload.id) ??
    (nested && !Array.isArray(nested) ? str(nested.id) : undefined)
  );
}

/** Pull the record array out of the several shapes Mindcase may return. */
function extractRecords(payload: MindcaseRecord | undefined): MindcaseRecord[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as MindcaseRecord[];
  for (const candidate of [
    payload.data,
    payload.results,
    payload.items,
    payload.posts,
    payload.comments,
  ]) {
    if (Array.isArray(candidate)) return candidate as MindcaseRecord[];
  }
  return [];
}

/** Keep per-request job ids out of the generic log label. */
function redactPath(path: string): string {
  return path.replace(/\/jobs\/[^/]+\//, "/jobs/.../");
}
