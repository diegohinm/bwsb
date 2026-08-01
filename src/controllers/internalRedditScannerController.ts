import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

import { getRedditDataConfig } from "../config/redditDataConfig.js";
import {
  createTestRedditProvider,
  ProviderDisabledError,
  providersForMode,
  type RedditScannerTestProvider,
} from "../providers/reddit/createTestRedditProvider.js";
import { AllRedditProvidersFailedError } from "../providers/reddit/providerErrors.js";
import {
  createObserverCollector,
  toObservedError,
  type ObservedProviderCall,
} from "../providers/reddit/providerObserver.js";
import type {
  NormalizedRedditPost,
  RedditProviderName,
} from "../providers/reddit/types.js";
import { persistPosts } from "../services/redditIngestionService.js";
import type { ScannerRequest } from "../middleware/validateRedditScannerRequest.js";

/**
 * The internal Reddit scanner test harness.
 *
 * Runs one manual scan through the REAL provider stack — the same classes,
 * normalization and deduplication the ingestion worker uses — and reports what
 * happened in enough detail to debug it: per-provider timings, duplicate
 * counts, an execution log, and the normalized record for every post.
 *
 * TWO HARD RULES
 *   1. NOTHING SECRET LEAVES. Every error goes through the observer's
 *      sanitizer; no stack trace, no API key, no upstream auth header is ever
 *      serialized into the response.
 *   2. NOTHING IS WRITTEN unless `persist` is true, and when it is, the write
 *      goes through `redditIngestionService.persistPosts` — the same path the
 *      worker uses. The controller contains no persistence logic of its own.
 */

/** Wire shape for one post. `raw` is present only when explicitly requested. */
interface ScannerPost {
  externalId: string;
  fullname: string | null;
  subreddit: string;
  author: string | null;
  title: string;
  body: string | null;
  permalink: string;
  url: string | null;
  score: number;
  upvoteRatio: number | null;
  commentCount: number;
  createdAt: string;
  fetchedAt: string;
  primarySource: RedditProviderName;
  sources: RedditProviderName[];
  raw: unknown;
}

type ScanStatus = "SUCCESS" | "PARTIAL" | "FAILED";

/** Timestamped execution-log line, e.g. `[21:42:10] Starting Reddit scan`. */
function logLine(message: string): string {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `[${hh}:${mm}:${ss}] ${message}`;
}

function toScannerPost(
  post: NormalizedRedditPost,
  includeRaw: boolean,
): ScannerPost {
  return {
    externalId: post.externalId,
    fullname: post.fullname,
    subreddit: post.subreddit,
    author: post.author,
    title: post.title,
    body: post.body,
    permalink: post.permalink,
    url: post.url,
    score: post.score,
    upvoteRatio: post.upvoteRatio,
    commentCount: post.commentCount,
    createdAt: post.createdAt.toISOString(),
    fetchedAt: post.fetchedAt.toISOString(),
    primarySource: post.primarySource,
    sources: post.sources,
    // Withheld by default: upstream payloads are large and are the most likely
    // place for an unexpected field to ride along.
    raw: includeRaw ? (post.raw ?? null) : null,
  };
}

/** Which providers actually answered, in call order. */
function providersThatAnswered(
  calls: ObservedProviderCall[],
  fallbackNames: RedditProviderName[],
): RedditProviderName[] {
  const succeeded = calls.filter((c) => c.success).map((c) => c.provider);
  return succeeded.length > 0 ? [...new Set(succeeded)] : fallbackNames;
}

/**
 * SUCCESS  every provider that ran answered
 * PARTIAL  at least one answered AND at least one failed
 * FAILED   nothing answered (handled on the error path)
 */
function statusFrom(calls: ObservedProviderCall[]): ScanStatus {
  const failed = calls.filter((c) => !c.success).length;
  const succeeded = calls.filter((c) => c.success).length;
  if (failed > 0 && succeeded > 0) return "PARTIAL";
  return "SUCCESS";
}

export async function testRedditScanner(
  req: Request,
  res: Response,
): Promise<void> {
  // Populated by validateRedditScannerRequest, which already normalized the
  // subreddit and clamped the limit.
  const input = res.locals.scannerRequest as ScannerRequest;
  const scanId = randomUUID();
  const logs: string[] = [];
  const startedAt = Date.now();

  logs.push(logLine("Starting Reddit scan"));
  logs.push(logLine(`Provider mode: ${input.provider}`));
  logs.push(logLine(`Subreddit: ${input.subreddit}`));
  logs.push(logLine(`Sort: ${input.sort} · limit: ${input.limit}`));

  const config = getRedditDataConfig();
  const { observer, calls } = createObserverCollector();

  let provider;
  try {
    provider = createTestRedditProvider(input.provider, { observer, config });
  } catch (error) {
    if (error instanceof ProviderDisabledError) {
      res.status(400).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    const safe = toObservedError(error);
    res.status(400).json({ success: false, error: safe });
    return;
  }

  let posts: NormalizedRedditPost[];
  try {
    posts = await provider.fetchPosts({
      subreddit: input.subreddit,
      sort: input.sort,
      limit: input.limit,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const safe =
      error instanceof AllRedditProvidersFailedError
        ? { code: "ALL_PROVIDERS_FAILED", message: error.message }
        : toObservedError(error);

    logs.push(logLine(`Scan failed: ${safe.message}`));
    // HTTP 200 with `success: false`, deliberately.
    //
    // The API call itself succeeded — a valid, authorized request ran a scan
    // and produced a diagnosis. What failed is the upstream being scanned, and
    // the per-provider stats plus execution log explaining WHICH upstream broke
    // are the entire value of this endpoint. A 5xx would make the frontend's
    // HTTP client discard that body and show a generic error instead.
    //
    // Genuine protocol errors keep their real codes: 400 for a bad request,
    // 403 for a caller who may not be here.
    res.status(200).json({
      success: false,
      error: safe,
      data: {
        scanId,
        status: "FAILED" satisfies ScanStatus,
        providerRequested: input.provider,
        providerUsed: [],
        subreddit: input.subreddit,
        sort: input.sort,
        requestedLimit: input.limit,
        receivedCount: 0,
        uniquePostCount: 0,
        duplicateCount: 0,
        durationMs,
        newestPostAt: null,
        oldestPostAt: null,
        newestPostAgeSeconds: null,
        persisted: false,
        insertedCount: 0,
        updatedCount: 0,
        failedCount: 0,
        providerStats: calls,
        logs,
        posts: [],
      },
    });
    return;
  }

  const durationMs = Date.now() - startedAt;

  for (const call of calls) {
    logs.push(
      call.success
        ? logLine(`${call.provider} returned ${call.receivedCount} posts in ${call.durationMs}ms`)
        : logLine(`${call.provider} failed: ${call.error?.message ?? "unknown error"}`),
    );
  }

  // Duplicates = records the providers returned in total, minus the distinct
  // Reddit ids that survived. For a single provider that is normally 0; in
  // hybrid it is the overlap between the two upstreams.
  const uniqueIds = new Set(posts.map((p) => p.externalId));
  const rawTotal = calls.length > 0
    ? calls.reduce((sum, call) => sum + call.receivedCount, 0)
    : posts.length;
  const duplicateCount = Math.max(0, rawTotal - uniqueIds.size);

  if (calls.length > 1) {
    logs.push(logLine(`Combined into ${uniqueIds.size} unique posts`));
  }

  const timestamps = posts.map((p) => p.createdAt.getTime()).sort((a, b) => a - b);
  const oldest = timestamps[0];
  const newest = timestamps[timestamps.length - 1];

  let persistedResult = { insertedCount: 0, updatedCount: 0, failedCount: 0 };
  if (input.persist && posts.length > 0) {
    logs.push(logLine(`Persisting ${posts.length} posts to PostgreSQL`));
    persistedResult = await persistPosts(posts);
    logs.push(
      logLine(
        `Persisted: ${persistedResult.insertedCount} inserted, ` +
          `${persistedResult.updatedCount} updated, ${persistedResult.failedCount} failed`,
      ),
    );
  } else {
    logs.push(logLine("Persistence disabled"));
  }

  logs.push(logLine(`Scan completed in ${(durationMs / 1000).toFixed(1)}s`));

  res.status(200).json({
    success: true,
    data: {
      scanId,
      status: statusFrom(calls),
      providerRequested: input.provider,
      providerUsed: providersThatAnswered(
        calls,
        providersForMode(input.provider, config),
      ),
      subreddit: input.subreddit,
      sort: input.sort,
      requestedLimit: input.limit,
      receivedCount: posts.length,
      uniquePostCount: uniqueIds.size,
      duplicateCount,
      durationMs,
      newestPostAt: newest !== undefined ? new Date(newest).toISOString() : null,
      oldestPostAt: oldest !== undefined ? new Date(oldest).toISOString() : null,
      newestPostAgeSeconds:
        newest !== undefined ? Math.max(0, Math.round((Date.now() - newest) / 1000)) : null,
      persisted: input.persist,
      insertedCount: persistedResult.insertedCount,
      updatedCount: persistedResult.updatedCount,
      failedCount: persistedResult.failedCount,
      // Only meaningful for composites; a single provider reports an empty list.
      providerStats: calls,
      logs,
      posts: posts
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((post) => toScannerPost(post, input.includeRaw)),
    },
  });
}

export type { ScannerPost, ScanStatus, RedditScannerTestProvider };
