import { createHash } from "node:crypto";

import { canonicalRedditUrl, normalizeFlair } from "../redditPermalink.js";

import { env } from "../../../config/env.js";
import { assertProviderCallsAllowed } from "../../../config/serviceRole.js";
import { redditConfig } from "../../../config/reddit.config.js";
import { classifySocialItem } from "../socialClassifier.service.js";
import { extractTickersFrom } from "../tickerExtractor.service.js";
import {
  assemblePulseResponse,
  assembleTickerFeed,
  type ResponseMeta,
} from "../socialData.assemble.js";
import type { SocialDataProvider } from "../socialData.provider.js";
import type {
  PulseTimeframe,
  SocialContentType,
  SocialFeedSort,
  SocialPostItem,
  SocialProviderStatus,
  SocialSentiment,
  SubredditPulseResponse,
  TickerSocialFeedResponse,
} from "../socialData.types.js";

/**
 * Mindcase (https://mindcase.co) social data provider. First real upstream.
 *
 * IMPORTANT
 *  - Only the BACKEND ever calls Mindcase. The API key is read from env here and
 *    is never returned to the client.
 *  - Mindcase's Reddit APIs run as async jobs: POST `/agents/reddit/posts/run`
 *    (Bearer auth) starts a job, results are polled from `/jobs/{id}/results`.
 *    The exact paths/field names below are based on Mindcase's documented Reddit
 *    skill; if your account's docs differ, adjust ONLY the constants + `mapItem`
 *    in this file — nothing else in the app knows Mindcase specifics.
 *  - RATE LIMITS. Mindcase is metered and answers 429 when pushed. Everything
 *    that touches the network here is bounded by env (see config/env.ts):
 *      MINDCASE_MAX_CONCURRENCY  how many subreddits at once      (default 2)
 *      MINDCASE_POLL_INTERVAL_MS delay between result polls        (default 3000)
 *      MINDCASE_MAX_POLLS        max result polls per job          (default 10)
 *      MINDCASE_MAX_RETRIES      retries after a 429/5xx           (default 3)
 *    A 429 honours `Retry-After` when present, otherwise backs off
 *    exponentially (2s → 4s → 8s) and finally raises MindcaseRateLimitError.
 *  - When the key/base URL are missing the provider reports `misconfigured` (it
 *    never throws on status). On a request failure the service layer serves
 *    stale cache or mock data — see services/social/index.ts.
 */

/** Raised when a live fetch is attempted without full configuration. */
export class MindcaseNotConfiguredError extends Error {
  constructor() {
    super("Mindcase is not configured (missing MINDCASE_API_KEY or MINDCASE_BASE_URL).");
    this.name = "MindcaseNotConfiguredError";
  }
}

/**
 * Raised when Mindcase keeps answering 429 after every allowed retry. A
 * CONTROLLED error: the service layer catches it and serves stale cache (or
 * labeled demo data) instead of failing the request.
 */
export class MindcaseRateLimitError extends Error {
  readonly status = 429;
  constructor(path: string) {
    super(`Mindcase rate limit reached for path ${redactPath(path)}`);
    this.name = "MindcaseRateLimitError";
  }
}

/** Raised when a job never produced results inside the poll budget. */
export class MindcaseJobTimeoutError extends Error {
  constructor(polls: number) {
    super(`Mindcase job did not complete within ${polls} result poll(s).`);
    this.name = "MindcaseJobTimeoutError";
  }
}

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESULTS_PER_SUBREDDIT = 50;
/** Backoff after a 429/5xx when the response carries no Retry-After header. */
const BACKOFF_BASE_MS = 2_000;
/** Never sleep longer than this on a single backoff, whatever Retry-After says. */
const MAX_BACKOFF_MS = 30_000;

/** Anonymize an author — we never store or expose raw Reddit usernames. */
function hashAuthor(author: string | undefined): string | undefined {
  if (!author) return undefined;
  return `anon_${createHash("sha256").update(author).digest("hex").slice(0, 12)}`;
}

/** Loosely-typed Mindcase Reddit record — field names vary, so read defensively. */
type MindcaseRecord = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function numOf(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

export class MindcaseSocialDataProvider implements SocialDataProvider {
  readonly name = "mindcase" as const;

  private get apiKey(): string | undefined {
    return env.MINDCASE_API_KEY;
  }
  private get baseUrl(): string | undefined {
    return env.MINDCASE_BASE_URL?.replace(/\/+$/, "");
  }
  private get configured(): boolean {
    return Boolean(this.apiKey && this.baseUrl);
  }

  async getStatus(): Promise<SocialProviderStatus> {
    const updatedAt = new Date().toISOString();
    if (!this.configured) {
      const missing = !this.apiKey ? "MINDCASE_API_KEY" : "MINDCASE_BASE_URL";
      return {
        provider: "mindcase",
        status: "misconfigured",
        source: "mindcase",
        networkAccess: false,
        message: `${missing} is not set — falling back to demo data.`,
        updatedAt,
      };
    }
    return {
      provider: "mindcase",
      status: "ready",
      source: "mindcase",
      networkAccess: true,
      message: "Mindcase provider active.",
      updatedAt,
    };
  }

  async getSubredditPulse(params: {
    timeframe: PulseTimeframe;
    q?: string;
    subreddits?: string[];
  }): Promise<SubredditPulseResponse> {
    if (!this.configured) throw new MindcaseNotConfiguredError();
    const subs = params.subreddits?.length
      ? params.subreddits
      : [...redditConfig.subreddits];
    const sweep = await this.fetchManySubreddits(subs, params.q);
    assertUsable(sweep);
    return assemblePulseResponse(
      sweep.items,
      params.timeframe,
      params.q,
      this.meta(partialWarning(sweep)),
      params.subreddits,
    );
  }

  async getTickerSocialFeed(params: {
    ticker: string;
    timeframe: PulseTimeframe;
    q?: string;
    type?: SocialContentType | "all";
    sentiment?: SocialSentiment | "all";
    subreddit?: string | "all";
    sort?: SocialFeedSort;
  }): Promise<TickerSocialFeedResponse> {
    if (!this.configured) throw new MindcaseNotConfiguredError();
    // Scope to a single subreddit when the caller asked for one, else sweep all.
    const subs =
      params.subreddit && params.subreddit !== "all"
        ? [params.subreddit.replace(/^r\//i, "")]
        : [...redditConfig.subreddits];
    // Search each community for the ticker cashtag.
    const sweep = await this.fetchManySubreddits(subs, `$${params.ticker}`);
    assertUsable(sweep);
    return assembleTickerFeed(sweep.items, params, this.meta(partialWarning(sweep)));
  }

  /**
   * Raw normalized items for the INGESTION WORKER.
   *
   * The worker persists these into social_posts/social_comments and computes the
   * pulse itself, so the aggregation is stored rather than recomputed per
   * request. Returns partial results plus which subreddits failed — a rate-limited
   * community never invalidates the ones that answered.
   */
  async fetchItems(params: {
    subreddits?: string[];
    keyword?: string;
  }): Promise<SweepResult> {
    if (!this.configured) throw new MindcaseNotConfiguredError();
    const subs = params.subreddits?.length
      ? params.subreddits
      : [...redditConfig.subreddits];
    return this.fetchManySubreddits(subs, params.keyword);
  }

  private meta(warning?: string): ResponseMeta {
    return {
      provider: "mindcase",
      source: "mindcase",
      isMock: false,
      updatedAt: new Date().toISOString(),
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Fetch posts for many subreddits through a concurrency-limited queue.
   *
   * NEVER `Promise.all(subs.map(...))` — that opens one Mindcase job per
   * subreddit at once and is exactly what earns a 429. At most
   * MINDCASE_MAX_CONCURRENCY (default 2) workers pull from a shared cursor, so
   * the upstream sees a steady trickle regardless of how many subreddits are
   * tracked.
   *
   * PARTIAL FAILURE: one subreddit failing never sinks the sweep. Failures are
   * collected and reported to the caller, which turns them into a `warning` on
   * an otherwise valid response.
   */
  private async fetchManySubreddits(
    subs: string[],
    keyword?: string,
  ): Promise<SweepResult> {
    const items: SocialPostItem[] = [];
    const failed: string[] = [];
    let rateLimited = false;
    let cursor = 0;

    const workerCount = Math.max(1, Math.min(env.MINDCASE_MAX_CONCURRENCY, subs.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < subs.length) {
        const sub = subs[cursor++];
        try {
          const records = await this.fetchSubredditPosts(sub, keyword);
          for (const r of records) {
            const item = this.mapItem(r, sub);
            if (item) items.push(item);
          }
        } catch (err) {
          failed.push(sub);
          if (isRateLimit(err)) rateLimited = true;
          console.error(`Mindcase: subreddit "${sub}" fetch failed:`, sanitizeErr(err));
        }
      }
    });
    await Promise.all(workers);

    return { items, failed, rateLimited, attempted: subs.length };
  }

  /** Run the Reddit-posts job for one subreddit and return raw records. */
  private async fetchSubredditPosts(
    subreddit: string,
    keyword?: string,
  ): Promise<MindcaseRecord[]> {
    const body = {
      params: {
        urls: `https://www.reddit.com/r/${subreddit}/`,
        ...(keyword ? { keyword } : {}),
        maxResults: MAX_RESULTS_PER_SUBREDDIT,
      },
    };

    const run = await this.request<MindcaseRecord>(
      "POST",
      "/agents/reddit/posts/run",
      body,
    );

    // Some jobs return data inline; otherwise poll for the job id's results.
    const inline = extractRecords(run);
    if (inline.length) return inline;

    const jobId =
      str(run.jobId) ?? str(run.job_id) ?? str(run.id) ?? str((run.data as MindcaseRecord)?.id);
    if (!jobId) return [];

    return this.pollJob(jobId);
  }

  /**
   * Poll `/jobs/{id}/results` until the job completes or the poll budget runs
   * out. At most MINDCASE_MAX_POLLS attempts, with at least
   * MINDCASE_POLL_INTERVAL_MS (default 3s) of sleep BETWEEN polls — tight
   * polling of this endpoint is what produced the original 429 storm.
   *
   * Throws MindcaseJobTimeoutError when the job never becomes ready. That is a
   * controlled failure for one subreddit: the sweep catches it and carries on.
   */
  private async pollJob(jobId: string): Promise<MindcaseRecord[]> {
    const maxPolls = env.MINDCASE_MAX_POLLS;
    for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
      const res = await this.request<MindcaseRecord>("GET", `/jobs/${jobId}/results`);
      const status = str(res.status)?.toLowerCase();
      const records = extractRecords(res);
      if (status === "completed" || status === "succeeded" || records.length) {
        return records;
      }
      if (status === "failed" || status === "error") return [];
      // Don't sleep after the final attempt — there is nothing left to wait for.
      if (attempt < maxPolls) await sleep(env.MINDCASE_POLL_INTERVAL_MS);
    }
    throw new MindcaseJobTimeoutError(maxPolls);
  }

  /** Normalize a Mindcase record into our SocialPostItem, classifying it. */
  private mapItem(r: MindcaseRecord, subreddit: string): SocialPostItem | null {
    const isComment = "commentText" in r || "comment" in r;
    const title = str(r.title);
    const text = str(r.text) ?? str(r.commentText) ?? str(r.body) ?? str(r.selftext);
    // `redditUrl` is what this provider actually returns. The other three were
    // guesses that never matched, which is why 1,522 of 1,527 stored posts had
    // no permalink and the feed could not offer "Open on Reddit" at all.
    const rawUrl =
      str(r.redditUrl) ?? str(r.postUrl) ?? str(r.url) ?? str(r.link) ?? str(r.permalink);
    const url = canonicalRedditUrl(rawUrl) ?? undefined;
    // An article or image the post links OUT to. Kept apart from the thread's
    // own permalink so the Reddit action can never point at a third-party page.
    const externalLink = str(r.externalLink);
    const redditId = str(r.redditId) ?? str(r.name);
    const media = r.media ?? r.image ?? r.thumbnail;
    const hasMedia =
      (Array.isArray(media) && media.length > 0) || typeof media === "string";
    const createdAt =
      str(r.posted) ??
      str(r.createdAt) ??
      str(r.created_utc) ??
      new Date().toISOString();

    if (!title && !text) return null;

    const flair =
      normalizeFlair(str(r.flair) ?? str(r.linkFlairText) ?? str(r.link_flair_text)) ?? undefined;
    const cls = classifySocialItem({
      title,
      text,
      flair,
      url,
      isComment,
      hasMedia,
    });
    const tickers = extractTickersFrom(title, text);
    const id =
      str(r.postId) ?? str(r.id) ?? `mc_${createHash("sha256").update(`${subreddit}:${title ?? text ?? url}`).digest("hex").slice(0, 16)}`;

    return {
      id,
      provider: "mindcase",
      source: "mindcase",
      subreddit,
      type: cls.contentType,
      title,
      text,
      url,
      authorHash: hashAuthor(str(r.author) ?? str(r.username)),
      score: numOf(r.score) ?? numOf(r.upvotes),
      numComments: numOf(r.comments) ?? numOf(r.numComments) ?? numOf(r.commentCount),
      createdAt,
      tickers,
      sentiment: cls.sentiment,
      stance: cls.stance,
      confidence: cls.confidence,
      isScreenshot: cls.isScreenshot,
      ...(flair ? { flair } : {}),
      ...(redditId ? { redditId } : {}),
      ...(externalLink ? { externalLink } : {}),
    };
  }

  /**
   * HTTP with Bearer auth, a per-attempt timeout, and rate-limit aware retries.
   *
   * 429 handling (MINDCASE_MAX_RETRIES attempts, default 3):
   *   - honour `Retry-After` (seconds or HTTP-date) when the header is present;
   *   - otherwise back off exponentially: 2s → 4s → 8s;
   *   - after the last retry raise MindcaseRateLimitError so callers can serve
   *     stale cache instead of an error.
   * 5xx and network/timeout errors use the same backoff ladder.
   *
   * The Authorization header is never logged: only method, redacted path and
   * status appear in messages, and sanitizeErr strips any stray Bearer token.
   */
  private async request<T = MindcaseRecord>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    // Hard process boundary: only the ingestion worker may reach Mindcase.
    assertProviderCallsAllowed("Mindcase");

    const url = `${this.baseUrl}${path}`;
    const maxRetries = env.MINDCASE_MAX_RETRIES;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const isLastAttempt = attempt === maxRetries;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (res.status === 429) {
          // Log the path only — never the key, never the full URL.
          console.warn(`Mindcase rate limit reached for path ${redactPath(path)}`);
          if (isLastAttempt) throw new MindcaseRateLimitError(path);
          await sleep(retryAfterMs(res.headers.get("retry-after"), attempt));
          continue;
        }

        if (!res.ok) {
          // 5xx is transient and worth the same backoff; other 4xx are not.
          if (res.status >= 500 && !isLastAttempt) {
            lastErr = new Error(`Mindcase ${method} ${redactPath(path)} -> ${res.status}`);
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new Error(`Mindcase ${method} ${redactPath(path)} -> ${res.status}`);
        }

        return (await res.json()) as T;
      } catch (err) {
        // A rate-limit error is final — it already exhausted its own retries.
        if (err instanceof MindcaseRateLimitError) throw err;
        lastErr = err;
        if (!isLastAttempt) {
          await sleep(backoffMs(attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Mindcase request failed");
  }
}

/** Outcome of one bounded sweep across several subreddits. */
export type SweepResult = {
  items: SocialPostItem[];
  /** Subreddits whose fetch failed (rate limit, job timeout, network, …). */
  failed: string[];
  /** True when at least one failure was a 429. */
  rateLimited: boolean;
  /** How many subreddits were attempted. */
  attempted: number;
};

/** True when an error means "Mindcase told us to slow down". */
export function isRateLimit(err: unknown): boolean {
  return err instanceof MindcaseRateLimitError || (err instanceof Error && err.name === "MindcaseRateLimitError");
}

/**
 * A sweep is usable when at least one subreddit answered. When EVERY attempt
 * failed there is no data to assemble — throw so the service layer serves stale
 * cache or labeled demo data instead of an empty "live" response.
 */
function assertUsable(sweep: SweepResult): void {
  if (sweep.items.length > 0) return;
  if (sweep.failed.length === 0 || sweep.failed.length < sweep.attempted) return;
  if (sweep.rateLimited) throw new MindcaseRateLimitError("/agents/reddit/posts/run");
  throw new Error(`Mindcase: all ${sweep.attempted} subreddit fetch(es) failed.`);
}

/** Warning for a response built from a partially successful sweep. */
function partialWarning(sweep: SweepResult): string | undefined {
  if (sweep.failed.length === 0) return undefined;
  const reason = sweep.rateLimited ? " (Mindcase rate limit)" : "";
  return (
    `Partial data: ${sweep.failed.length} of ${sweep.attempted} subreddits ` +
    `unavailable${reason}.`
  );
}

/** Exponential backoff for retry `attempt` (0-based): 2s, 4s, 8s, … capped. */
function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/**
 * How long to wait after a 429. Prefers the `Retry-After` header — seconds or
 * an HTTP-date — and falls back to exponential backoff. Always clamped so a
 * hostile/odd header can't park a worker for minutes.
 */
function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_BACKOFF_MS, seconds * 1000);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.min(MAX_BACKOFF_MS, Math.max(0, date - Date.now()));
    }
  }
  return backoffMs(attempt);
}

/** Replace job ids in a path so logs never carry per-request identifiers. */
function redactPath(path: string): string {
  return path.replace(/\/jobs\/[^/]+\//, "/jobs/.../");
}

/** Pull an array of records out of the various shapes Mindcase may return. */
function extractRecords(payload: MindcaseRecord | undefined): MindcaseRecord[] {
  if (!payload) return [];
  const candidates = [payload.data, payload.results, payload.items, payload.posts];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as MindcaseRecord[];
  }
  if (Array.isArray(payload)) return payload as unknown as MindcaseRecord[];
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip anything secret-looking before logging an error. */
function sanitizeErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/Bearer\s+[A-Za-z0-9_\-.]+/g, "Bearer ***");
}

export const mindcaseSocialDataProvider = new MindcaseSocialDataProvider();
