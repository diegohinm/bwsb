import { createHash } from "node:crypto";

import { env } from "../../../config/env.js";
import { TRACKED_SUBREDDIT_NAMES } from "../subreddits.js";
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
 *  - Requests are timed out and retried at most once. When the key/base URL are
 *    missing the provider reports `misconfigured` (it never throws on status).
 *    On a request failure the service layer falls back to mock data.
 */

/** Raised when a live fetch is attempted without full configuration. */
export class MindcaseNotConfiguredError extends Error {
  constructor() {
    super("Mindcase is not configured (missing MINDCASE_API_KEY or MINDCASE_BASE_URL).");
    this.name = "MindcaseNotConfiguredError";
  }
}

const REQUEST_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 25_000;
const MAX_RESULTS_PER_SUBREDDIT = 50;
/** Limit concurrent jobs so we stay inside Mindcase rate limits. */
const CONCURRENCY = 3;

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
      : [...TRACKED_SUBREDDIT_NAMES];
    const items = await this.fetchManySubreddits(subs, params.q);
    return assemblePulseResponse(items, params.timeframe, params.q, this.meta());
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
        : [...TRACKED_SUBREDDIT_NAMES];
    // Search each community for the ticker cashtag.
    const items = await this.fetchManySubreddits(subs, `$${params.ticker}`);
    return assembleTickerFeed(items, params, this.meta());
  }

  private meta(): ResponseMeta {
    return {
      provider: "mindcase",
      source: "mindcase",
      isMock: false,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Fetch posts for many subreddits with a bounded concurrency pool. */
  private async fetchManySubreddits(
    subs: string[],
    keyword?: string,
  ): Promise<SocialPostItem[]> {
    const out: SocialPostItem[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, subs.length) }, async () => {
      while (cursor < subs.length) {
        const sub = subs[cursor++];
        try {
          const records = await this.fetchSubredditPosts(sub, keyword);
          for (const r of records) {
            const item = this.mapItem(r, sub);
            if (item) out.push(item);
          }
        } catch (err) {
          // One subreddit failing shouldn't sink the whole request — log and go on.
          console.error(`Mindcase: subreddit "${sub}" fetch failed:`, sanitizeErr(err));
        }
      }
    });
    await Promise.all(workers);
    return out;
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

  /** Poll `/jobs/{id}/results` until completed or the poll budget elapses. */
  private async pollJob(jobId: string): Promise<MindcaseRecord[]> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await this.request<MindcaseRecord>("GET", `/jobs/${jobId}/results`);
      const status = str(res.status)?.toLowerCase();
      const records = extractRecords(res);
      if (status === "completed" || status === "succeeded" || records.length) {
        return records;
      }
      if (status === "failed" || status === "error") return [];
      await sleep(POLL_INTERVAL_MS);
    }
    return [];
  }

  /** Normalize a Mindcase record into our SocialPostItem, classifying it. */
  private mapItem(r: MindcaseRecord, subreddit: string): SocialPostItem | null {
    const isComment = "commentText" in r || "comment" in r;
    const title = str(r.title);
    const text = str(r.text) ?? str(r.commentText) ?? str(r.body) ?? str(r.selftext);
    const url = str(r.postUrl) ?? str(r.url) ?? str(r.link);
    const media = r.media ?? r.image ?? r.thumbnail;
    const hasMedia =
      (Array.isArray(media) && media.length > 0) || typeof media === "string";
    const createdAt =
      str(r.posted) ??
      str(r.createdAt) ??
      str(r.created_utc) ??
      new Date().toISOString();

    if (!title && !text) return null;

    const cls = classifySocialItem({
      title,
      text,
      flair: str(r.flair) ?? str(r.linkFlairText),
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
    };
  }

  /** HTTP with Bearer auth, timeout, and a single safe retry. */
  private async request<T = MindcaseRecord>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= 1; attempt += 1) {
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
        if (!res.ok) {
          // 429/5xx are worth one retry; 4xx are not.
          if ((res.status === 429 || res.status >= 500) && attempt === 0) {
            lastErr = new Error(`Mindcase ${method} ${path} -> ${res.status}`);
            await sleep(POLL_INTERVAL_MS);
            continue;
          }
          throw new Error(`Mindcase ${method} ${path} -> ${res.status}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        // Retry once on network/timeout errors only.
        if (attempt === 0) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Mindcase request failed");
  }
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
