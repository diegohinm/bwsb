import { assertProviderCallsAllowed } from "../../config/serviceRole.js";
import type { MindcaseConfig, RedditDataConfig } from "../../config/redditDataConfig.js";
import { requestJson, sleep } from "./httpClient.js";
import {
  AGENT_INPUT_FIELD,
  buildRedditPostsPayload,
  describeRun,
  extractValidationMessage,
  normalizeSubredditName,
  readAgentDefinition,
  suggestedInputFields,
  type RedditPostsAgentDefinition,
  type RedditPostsAgentPayload,
} from "./mindcaseRedditRequest.js";
import {
  normalizeComments,
  normalizeMindcaseComment,
  normalizeMindcasePost,
  normalizePosts,
  toBareId,
} from "./normalizeRedditData.js";
import {
  RedditProviderError,
  sanitizeProviderError,
  sanitizeText,
} from "./providerErrors.js";
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
 * Paths are relative to the VERSIONED root (`…/api/v1`), which
 * `redditDataConfig` guarantees is present exactly once in `baseUrl`.
 *
 * All of that — job creation, polling budget, 429 backoff, the loosely-typed
 * record shapes — is contained here. Callers only ever see normalized posts and
 * comments, exactly like every other provider. No service, route or controller
 * may import this class directly; they go through `RedditProviderFactory`.
 *
 * REQUEST TRANSLATION
 * The agent has its own vocabulary (`URL`, `maxPostCount`, `skipComments` …).
 * Our normalized input is translated into it by `mindcaseRedditRequest.ts`;
 * internal fields — provider, subreddit, limit, persist — never go on the wire.
 * Exactly ONE payload shape is ever sent: probing alternatives against a
 * metered API can start duplicate jobs. `describeAgent()` is the supported way
 * to find out what this account expects.
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

/**
 * Read-only places an account may publish its agent definition.
 *
 * GET only, and only from `describeAgent()` — none of these creates a job or
 * costs credits.
 */
const AGENT_DEFINITION_PATHS = [
  "/agents/reddit/posts",
  "/agents/reddit/posts/definition",
  "/agents/reddit/posts/schema",
];

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

    const subreddit = normalizeSubredditName(input.subreddit);
    if (!subreddit) {
      throw new RedditProviderError(
        this.name,
        "client",
        "fetchPosts requires a subreddit.",
      );
    }

    // The normalized input the app speaks internally is TRANSLATED here into
    // the agent's contract. Nothing from `input` is spread onto the payload —
    // sending our own field names is what earned HTTP 422.
    const payload = buildRedditPostsPayload({
      subreddit,
      sort: input.sort,
      limit: input.limit,
    });

    // Everything an operator needs to reproduce the call, and nothing that
    // could identify the account: no key, no Authorization header, no base URL.
    console.log(
      `[MindcaseProvider] Running Reddit posts agent ${JSON.stringify(
        describeRun(payload),
      )}`,
    );

    const fetchedAt = new Date();
    const records = await trackProviderCall(this.name, () =>
      this.runPostsJob(payload),
    );

    const posts = normalizePosts(records, normalizeMindcasePost, {
      subreddit,
      fetchedAt,
    });

    // `query` is not part of the agent's contract, so it is applied here rather
    // than silently dropped.
    const matching = input.query ? posts.filter(matchesQuery(input.query)) : posts;

    const filtered = filterByWindow(matching, input.after, input.before).slice(
      0,
      payload.maxItems,
    );
    console.log(
      `[MindcaseProvider] Fetched ${filtered.length} posts subreddit=${subreddit}`,
    );
    return filtered;
  }

  /**
   * Run the posts agent — ONE request, ONE payload shape.
   *
   * Deliberately no automatic retry with an alternative body: probing shapes
   * against a metered API risks starting duplicate jobs and burning credits for
   * a guess. A rejection is reported with the field names the upstream itself
   * asked for, and the fix is a code change or `describeAgent()`, not another
   * request the operator never approved.
   */
  private async runPostsJob(
    payload: RedditPostsAgentPayload,
  ): Promise<MindcaseRecord[]> {
    try {
      return await this.runJob(POSTS_JOB_PATH, payload);
    } catch (error) {
      if (!isValidationError(error)) throw error;

      const message = this.describeRejection(error);
      const wanted = suggestedInputFields(error.details);
      console.error(
        `[MindcaseProvider] Mindcase rejected the request status=422 ` +
          `sentInputField=${AGENT_INPUT_FIELD} detail=${message}`,
      );
      if (wanted.length > 0) {
        console.error(
          `[MindcaseProvider] The agent asked for: ${wanted.join(", ")}. ` +
            "Run `npm run mindcase:agent` to read the account's agent definition; " +
            "no alternative payload is sent automatically.",
        );
      }

      throw this.rejectionError(message);
    }
  }

  /**
   * DEVELOPMENT DIAGNOSTIC — what does this account's `reddit/posts` agent
   * actually declare?
   *
   * Accounts differ on the input field (`URL`, `startUrls`, `searches`), and a
   * 422 only says which one is missing. This asks the API directly, with GET
   * requests against read-only definition paths: no job is created and no
   * credits are spent. Never called on the scan path — `npm run mindcase:agent`
   * or an explicit call is the only way in.
   *
   * Returns null when the account publishes no definition this app can read.
   */
  async describeAgent(): Promise<RedditPostsAgentDefinition | null> {
    this.assertConfigured();
    assertProviderCallsAllowed("Mindcase");

    for (const path of AGENT_DEFINITION_PATHS) {
      let payload: MindcaseRecord;
      try {
        payload = await this.request<MindcaseRecord>("GET", path);
      } catch (error) {
        // A 404/405 just means this account exposes the definition elsewhere.
        console.warn(
          `[MindcaseProvider] ${path} did not answer with a definition: ${sanitizeProviderError(error)}`,
        );
        continue;
      }

      const definition = readAgentDefinition(payload);
      if (definition.allParams.length === 0) continue;

      console.log(
        `[MindcaseProvider] Agent definition from ${path}: ` +
          `requiredParams=[${definition.requiredParams.join(", ")}] ` +
          `allParams=[${definition.allParams.join(", ")}] ` +
          `sendingInputField=${AGENT_INPUT_FIELD} ` +
          `matches=${definition.matchesConfiguredInputField}`,
      );
      return definition;
    }

    console.warn(
      "[MindcaseProvider] No readable agent definition; the input field cannot be confirmed from the API.",
    );
    return null;
  }

  /**
   * The upstream's validation complaint, in one sanitized line.
   *
   * Two passes of redaction, because this string reaches both a log line and
   * the scanner UI: the generic credential scrubber, then an exact-match strip
   * of our own key in case the upstream echoed the Authorization header back.
   */
  private describeRejection(error: RedditProviderError): string {
    const raw = extractValidationMessage(error.details) ?? "no validation detail provided";
    const scrubbed = sanitizeText(raw);
    const key = this.settings.apiKey;
    return key ? scrubbed.split(key).join("***") : scrubbed;
  }

  private rejectionError(message: string): RedditProviderError {
    return new RedditProviderError(
      this.name,
      "upstream_validation",
      `Mindcase rejected the request: ${message}`,
      422,
    );
  }

  async fetchComments(
    input: RedditFetchCommentsInput,
  ): Promise<NormalizedRedditComment[]> {
    this.assertConfigured();
    assertProviderCallsAllowed("Mindcase");

    const subreddit = normalizeSubredditName(input.subreddit ?? "");
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

/** A 422 from the upstream, carrying whatever body it sent with it. */
function isValidationError(error: unknown): error is RedditProviderError {
  return (
    error instanceof RedditProviderError && error.kind === "upstream_validation"
  );
}

/** Case-insensitive title/body match, for the `query` the agent cannot filter. */
function matchesQuery(query: string): (post: NormalizedRedditPost) => boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return () => true;
  return (post) =>
    post.title.toLowerCase().includes(needle) ||
    (post.body?.toLowerCase().includes(needle) ?? false);
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
