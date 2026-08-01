import {
  arcticShiftWorkerConfig,
  redditConfig,
  type ArcticShiftWorkerConfig,
  type RedditConfig,
} from "../../config/reddit.config.js";
import type { ArcticShiftPage, ArcticShiftPageInput } from "../../providers/reddit/ArcticShiftProvider.js";
import {
  RedditProviderError,
  sanitizeProviderError,
} from "../../providers/reddit/providerErrors.js";
import type { NormalizedRedditPost } from "../../providers/reddit/types.js";
import type { PersistPostsResult } from "../../services/redditIngestionService.js";
import { ArcticShiftRateGuard } from "./arcticShiftRateGuard.js";
import {
  ARCTIC_SHIFT_WORKER_NAME,
  ArcticShiftScheduler,
  type SchedulerSelection,
} from "./arcticShiftScheduler.js";
import type { RedditWorkerStore } from "./redditWorkerStore.js";

/**
 * THE ARCTIC SHIFT INGESTION CYCLE — one subreddit, one HTTP request.
 *
 * Arctic Shift is a free community archive. YOLOPulse repays that by being the
 * quietest possible client: **one** request every five minutes, for the whole
 * system, rotating through `REDDIT_SUBREDDITS`. Five communities therefore see
 * 12 requests an hour in total and one visit each per 25 minutes.
 *
 * The rules that make it true, and where each one lives:
 *
 *   one request per cycle      this file — `fetchPage` is called exactly once
 *   ≥5 min between requests    ArcticShiftRateGuard (persisted lastRequestAt)
 *   ≤12 requests per hour      ArcticShiftRateGuard (persisted rolling log)
 *   no HTTP-level retries      ArcticShiftProvider.fetchPostsPage (maxRetries 0)
 *   no concurrent requests     the in-process flag below + the DB lease
 *   rotation survives restarts ArcticShiftScheduler (persisted index)
 *
 * A FAILURE IS NOT A RETRY. Every attempt — success, timeout, 429, 500 — spends
 * the cycle's single request. A failed subreddit is simply tried again on its
 * next turn, and after `ARCTIC_SHIFT_MAX_RETRIES` consecutive failures it is
 * cooled down so a permanently broken community cannot eat every Nth slot.
 *
 * THE MANUAL SCANNER IS NOT AFFECTED. `POST /api/internal/reddit/scanner/test`
 * builds its own provider and never touches the guard, the rotation index or
 * the cursors. That is deliberate: the operator debugging an upstream must not
 * be made to wait five minutes, and their scan must not shift the worker's
 * schedule.
 */

export const ARCTIC_SHIFT_PROVIDER = "arctic_shift";
export const POST_CONTENT_TYPE = "post";

/** Wire-stable outcome codes. They end up in `worker_runs` and the cursor row. */
export type CycleStatus =
  | "SUCCESS"
  | "EMPTY"
  | "SKIPPED_COOLDOWN"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "VALIDATION_FAILED"
  | "PERSIST_FAILED"
  | "PROVIDER_ERROR";

/** Indexing lag: how old a post already was when the archive handed it over. */
export interface LatencyStats {
  minimum: number;
  average: number;
  p50: number;
  p95: number;
  maximum: number;
}

export interface CycleMetrics {
  provider: string;
  subreddit: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  requestStatus: CycleStatus;
  httpStatus: number | null;
  errorCode: string | null;
  receivedCount: number;
  normalizedCount: number;
  duplicateCount: number;
  insertedCount: number;
  updatedCount: number;
  failedCount: number;
  newestPostAt: string | null;
  oldestPostAt: string | null;
  newestPostAgeSeconds: number | null;
  ingestionLatencySeconds: LatencyStats | null;
  hasMore: boolean;
  windowAfter: string | null;
  windowBefore: string | null;
  requestsLastHour: number;
  nextSubreddit: string;
  nextRequestAt: string;
  /** Reserved `status` key read by jobRunner when this is used as a job. */
  status?: string;
}

export interface ArcticShiftCycleDeps {
  store: RedditWorkerStore;
  scheduler: ArcticShiftScheduler;
  guard: ArcticShiftRateGuard;
  /** One request. Bound to `ArcticShiftProvider.fetchPostsPage` in production. */
  fetchPage: (input: ArcticShiftPageInput) => Promise<ArcticShiftPage>;
  /** `redditIngestionService.persistPosts` — the worker owns no Prisma logic. */
  persist: (posts: NormalizedRedditPost[]) => Promise<PersistPostsResult>;
  config?: RedditConfig;
  workerConfig?: ArcticShiftWorkerConfig;
  now?: () => number;
}

/**
 * Run exactly one cycle: pick a subreddit, make one request, persist, advance.
 *
 * Never throws — a cycle that fails reports its failure in the returned metrics
 * and the rotation moves on. The only way to stop the worker is a signal.
 */
export async function runArcticShiftCycle(
  deps: ArcticShiftCycleDeps,
  options: { waitForSlot?: boolean } = {},
): Promise<CycleMetrics> {
  const config = deps.config ?? redditConfig;
  const workerConfig = deps.workerConfig ?? arcticShiftWorkerConfig;
  const now = deps.now ?? (() => Date.now());
  const startedAt = new Date(now());

  const selection = await deps.scheduler.peek();
  const { subreddit } = selection;

  console.log(
    [
      "[ArcticShiftWorker] Cycle started",
      `subreddit=${subreddit}`,
      `requestNumber=${(await deps.guard.requestsLastHour()) + 1}`,
      `intervalMs=${config.pollIntervalMs}`,
    ].join("\n"),
  );

  const cursor = await deps.store.getCursor(
    ARCTIC_SHIFT_PROVIDER,
    subreddit,
    POST_CONTENT_TYPE,
  );

  // A cooled-down subreddit costs NO request: skip straight to the next one so
  // the slot is spent on a community that can actually answer.
  if (cursor?.cooldownUntil && cursor.cooldownUntil.getTime() > now()) {
    console.warn(
      `[ArcticShiftWorker] Skipping subreddit=${subreddit} — cooldown until ` +
        `${cursor.cooldownUntil.toISOString()} after ${cursor.consecutiveFailures} failures`,
    );
    await deps.scheduler.advance(selection);
    return finish({
      deps,
      selection,
      startedAt,
      now,
      requestStatus: "SKIPPED_COOLDOWN",
      errorCode: cursor.lastErrorCode ?? "COOLDOWN",
    });
  }

  const window = resolveWindow({ cursor, config, now });

  // Wait for the slot BEFORE announcing the fetch, so the log line and the
  // request happen together.
  if (options.waitForSlot !== false) {
    const decision = await deps.guard.check();
    if (!decision.allowed && decision.reason === "hourly_cap") {
      console.warn(
        "[ArcticShiftWorker] RATE_GUARD_TRIGGERED — the hourly ceiling of 12 requests is reached; " +
          `no request will be made before ${decision.nextAllowedAt.toISOString()}`,
      );
    }
    await deps.guard.waitUntilAllowed();
  }

  console.log(
    [
      "[ArcticShiftWorker] Fetching posts",
      `subreddit=${subreddit}`,
      `after=${window.after.toISOString()}`,
      `before=${window.before.toISOString()}`,
      `limit=${config.postLimit}`,
    ].join("\n"),
  );

  await deps.store.recordCursorAttempt(
    ARCTIC_SHIFT_PROVIDER,
    subreddit,
    POST_CONTENT_TYPE,
    new Date(now()),
  );
  // Counted BEFORE the request leaves: a hung or throwing request still used
  // the upstream's capacity.
  await deps.guard.recordRequestStarted();

  let page: ArcticShiftPage;
  try {
    page = await deps.fetchPage({
      subreddit,
      after: window.after,
      before: window.before,
      limit: config.postLimit,
      // Ascending: oldest first inside the window, so a truncated page ends at a
      // timestamp the cursor can safely resume from.
      sort: "asc",
      timeoutMs: workerConfig.requestTimeoutMs,
    });
  } catch (error) {
    return handleFailure({ deps, selection, startedAt, now, window, error, workerConfig });
  }

  // The overlap re-reads the boundary on purpose, so duplicates are expected.
  const unique = deduplicate(page.posts);
  const duplicateCount = page.posts.length - unique.length;

  let persisted: PersistPostsResult;
  try {
    persisted = await deps.persist(unique);
  } catch (error) {
    // THE CURSOR DOES NOT MOVE. Posts that were fetched but not written stay
    // inside the next window; losing them here would lose them forever.
    return handleFailure({
      deps,
      selection,
      startedAt,
      now,
      window,
      error,
      workerConfig,
      forcedStatus: "PERSIST_FAILED",
      receivedCount: page.receivedCount,
      normalizedCount: unique.length,
      duplicateCount,
    });
  }

  // Everything succeeded — fetch, normalization AND persistence — so the cursor
  // may advance. An empty batch keeps the existing cursor: an archive with
  // indexing lag must not have its window skipped forward to "now".
  const newest = newestPost(unique);
  await deps.store.recordCursorSuccess(
    ARCTIC_SHIFT_PROVIDER,
    subreddit,
    POST_CONTENT_TYPE,
    {
      lastCreatedAt: newest?.createdAt ?? null,
      lastExternalId: newest?.externalId ?? null,
      hasMore: page.hasMore,
      syncedAt: new Date(now()),
    },
  );
  await deps.store.recordCycleOutcome(deps.scheduler.workerName, {
    success: true,
    at: new Date(now()),
  });
  await deps.guard.clearRetryAfter();
  await deps.scheduler.advance(selection);

  const metrics = await finish({
    deps,
    selection,
    startedAt,
    now,
    requestStatus: unique.length === 0 ? "EMPTY" : "SUCCESS",
    receivedCount: page.receivedCount,
    normalizedCount: unique.length,
    duplicateCount,
    persisted,
    posts: unique,
    hasMore: page.hasMore,
    window,
  });

  console.log(
    [
      "[ArcticShiftWorker] Fetch completed",
      `subreddit=${subreddit}`,
      `received=${metrics.receivedCount}`,
      `unique=${metrics.normalizedCount}`,
      `inserted=${metrics.insertedCount}`,
      `updated=${metrics.updatedCount}`,
      `durationMs=${metrics.durationMs}`,
    ].join("\n"),
  );
  if (page.hasMore) {
    console.log(
      `[ArcticShiftWorker] Page was full — subreddit=${subreddit} resumes from ` +
        `${newest?.createdAt.toISOString() ?? "the stored cursor"} on its NEXT turn (no extra request now).`,
    );
  }
  console.log(
    [
      "[ArcticShiftWorker] Next request allowed",
      `nextSubreddit=${metrics.nextSubreddit}`,
      `nextRequestAt=${metrics.nextRequestAt}`,
    ].join("\n"),
  );

  return metrics;
}

// ── window ───────────────────────────────────────────────────────────────────

interface Window {
  after: Date;
  before: Date;
}

/**
 * Where to read from.
 *
 * With a cursor: from the last persisted post MINUS the overlap, because an
 * archive can index a post after one with a later timestamp. Without one: a
 * bounded look-back, never "everything ever posted".
 *
 * `hasMore` needs no special case — the cursor already sits at the last post
 * that was actually stored, so resuming from it is exactly "continue where the
 * truncated page stopped".
 */
function resolveWindow(input: {
  cursor: { lastCreatedAt: Date | null } | null;
  config: RedditConfig;
  now: () => number;
}): Window {
  const nowMs = input.now();
  const before = new Date(nowMs);
  const last = input.cursor?.lastCreatedAt;

  const after = last
    ? new Date(last.getTime() - input.config.cursorOverlapSeconds * 1000)
    : new Date(nowMs - input.config.initialLookbackMinutes * 60 * 1000);

  return { after, before };
}

// ── failure handling ─────────────────────────────────────────────────────────

/**
 * Classify a failure, record it, and move on. NO immediate retry, ever.
 *
 * The cursor is left untouched by every branch: a window that was not
 * successfully ingested must be read again, not skipped.
 */
async function handleFailure(input: {
  deps: ArcticShiftCycleDeps;
  selection: SchedulerSelection;
  startedAt: Date;
  now: () => number;
  window: Window;
  error: unknown;
  workerConfig: ArcticShiftWorkerConfig;
  forcedStatus?: CycleStatus;
  receivedCount?: number;
  normalizedCount?: number;
  duplicateCount?: number;
}): Promise<CycleMetrics> {
  const { deps, selection, error, workerConfig, now } = input;
  const subreddit = selection.subreddit;
  const classified = input.forcedStatus
    ? { status: input.forcedStatus, httpStatus: null as number | null }
    : classifyError(error);
  const message = sanitizeProviderError(error);

  // A 429 is the one failure that also moves the NEXT allowed time: the
  // upstream told us how long to stay away, and it wins over our own interval.
  if (classified.status === "RATE_LIMITED" && error instanceof RedditProviderError) {
    const seconds = error.retryAfterSeconds ?? 0;
    await deps.guard.registerRetryAfter(new Date(now() + seconds * 1000));
  }

  const previousFailures = (
    await deps.store.getCursor(ARCTIC_SHIFT_PROVIDER, subreddit, POST_CONTENT_TYPE)
  )?.consecutiveFailures ?? 0;
  const failures = previousFailures + 1;
  const cooldown =
    failures >= workerConfig.maxFailuresBeforeCooldown
      ? new Date(now() + workerConfig.subredditCooldownMs)
      : null;

  await deps.store.recordCursorFailure(ARCTIC_SHIFT_PROVIDER, subreddit, POST_CONTENT_TYPE, {
    errorCode: classified.status,
    errorMessage: message,
    attemptedAt: new Date(now()),
    cooldownUntil: cooldown,
  });
  await deps.store.recordCycleOutcome(deps.scheduler.workerName, {
    success: false,
    at: new Date(now()),
  });

  console.error(
    `[ArcticShiftWorker] ${classified.status} subreddit=${subreddit} ` +
      `httpStatus=${classified.httpStatus ?? "n/a"} failures=${failures} — ${message}`,
  );
  if (cooldown) {
    console.warn(
      `[ArcticShiftWorker] subreddit=${subreddit} reached ${failures} consecutive failures — ` +
        `cooling down until ${cooldown.toISOString()}. Cursor left untouched.`,
    );
  }
  if (classified.status === "VALIDATION_FAILED") {
    console.error(
      `[ArcticShiftWorker] subreddit=${subreddit} needs REVIEW: the upstream rejected the ` +
        "request itself. The same query will not be sent again until it stops failing " +
        "or the subreddit is removed from REDDIT_SUBREDDITS.",
    );
  }

  // The rotation moves on regardless: one broken subreddit must not stall the
  // other four.
  await deps.scheduler.advance(selection);

  return finish({
    deps,
    selection,
    startedAt: input.startedAt,
    now,
    requestStatus: classified.status,
    httpStatus: classified.httpStatus,
    errorCode: classified.status,
    ...(input.receivedCount !== undefined ? { receivedCount: input.receivedCount } : {}),
    ...(input.normalizedCount !== undefined ? { normalizedCount: input.normalizedCount } : {}),
    ...(input.duplicateCount !== undefined ? { duplicateCount: input.duplicateCount } : {}),
    window: input.window,
  });
}

/** Map a thrown value onto the wire-stable status codes. */
export function classifyError(error: unknown): {
  status: CycleStatus;
  httpStatus: number | null;
} {
  if (!(error instanceof RedditProviderError)) {
    return { status: "PROVIDER_ERROR", httpStatus: null };
  }
  const httpStatus = error.status ?? null;

  switch (error.kind) {
    case "rate_limit":
      return { status: "RATE_LIMITED", httpStatus };
    case "timeout":
      return { status: "TIMEOUT", httpStatus };
    case "server":
    case "network":
      return { status: "UPSTREAM_UNAVAILABLE", httpStatus };
    case "upstream_validation":
      return { status: "VALIDATION_FAILED", httpStatus };
    case "client":
      // 400 and 422 are our request's fault; anything else 4xx is treated the
      // same way, because retrying it identically is equally pointless.
      return { status: "VALIDATION_FAILED", httpStatus };
    default:
      return { status: "PROVIDER_ERROR", httpStatus };
  }
}

// ── metrics ──────────────────────────────────────────────────────────────────

/** Keep one record per Reddit id; the overlap guarantees repeats. */
export function deduplicate(posts: NormalizedRedditPost[]): NormalizedRedditPost[] {
  const byId = new Map<string, NormalizedRedditPost>();
  for (const post of posts) {
    if (!post.externalId) continue;
    // Last wins: a later record in the same page is the fresher observation.
    byId.set(post.externalId, post);
  }
  return [...byId.values()];
}

function newestPost(posts: NormalizedRedditPost[]): NormalizedRedditPost | undefined {
  return posts.reduce<NormalizedRedditPost | undefined>(
    (newest, post) =>
      !newest || post.createdAt.getTime() > newest.createdAt.getTime() ? post : newest,
    undefined,
  );
}

/**
 * Indexing latency, in seconds: how long after a post was created did the
 * archive hand it to us.
 *
 * This is the number that decides whether Arctic Shift can be YOLOPulse's
 * primary provider — a p95 of minutes is usable, a p95 of hours is not.
 */
export function latencyStats(posts: NormalizedRedditPost[]): LatencyStats | null {
  const samples = posts
    .map((post) => (post.fetchedAt.getTime() - post.createdAt.getTime()) / 1000)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (samples.length === 0) return null;

  const at = (fraction: number): number => {
    const index = Math.min(
      samples.length - 1,
      Math.max(0, Math.ceil(fraction * samples.length) - 1),
    );
    return round(samples[index] as number);
  };

  return {
    minimum: round(samples[0] as number),
    average: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    p50: at(0.5),
    p95: at(0.95),
    maximum: round(samples[samples.length - 1] as number),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Assemble the metrics row every exit path returns. */
async function finish(input: {
  deps: ArcticShiftCycleDeps;
  selection: SchedulerSelection;
  startedAt: Date;
  now: () => number;
  requestStatus: CycleStatus;
  httpStatus?: number | null;
  errorCode?: string | null;
  receivedCount?: number;
  normalizedCount?: number;
  duplicateCount?: number;
  persisted?: PersistPostsResult;
  posts?: NormalizedRedditPost[];
  hasMore?: boolean;
  window?: Window;
}): Promise<CycleMetrics> {
  const { deps, selection, now } = input;
  const completedAt = new Date(now());
  const posts = input.posts ?? [];
  const timestamps = posts.map((post) => post.createdAt.getTime()).sort((a, b) => a - b);
  const oldest = timestamps[0];
  const newest = timestamps[timestamps.length - 1];

  return {
    provider: ARCTIC_SHIFT_PROVIDER,
    subreddit: selection.subreddit,
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - input.startedAt.getTime(),
    requestStatus: input.requestStatus,
    httpStatus: input.httpStatus ?? null,
    errorCode: input.errorCode ?? null,
    receivedCount: input.receivedCount ?? 0,
    normalizedCount: input.normalizedCount ?? posts.length,
    duplicateCount: input.duplicateCount ?? 0,
    insertedCount: input.persisted?.insertedCount ?? 0,
    updatedCount: input.persisted?.updatedCount ?? 0,
    failedCount: input.persisted?.failedCount ?? 0,
    newestPostAt: newest !== undefined ? new Date(newest).toISOString() : null,
    oldestPostAt: oldest !== undefined ? new Date(oldest).toISOString() : null,
    newestPostAgeSeconds:
      newest !== undefined ? Math.max(0, Math.round((now() - newest) / 1000)) : null,
    ingestionLatencySeconds: latencyStats(posts),
    hasMore: input.hasMore ?? false,
    windowAfter: input.window?.after.toISOString() ?? null,
    windowBefore: input.window?.before.toISOString() ?? null,
    requestsLastHour: await deps.guard.requestsLastHour(),
    nextSubreddit: selection.nextSubreddit,
    nextRequestAt: (await deps.guard.getNextAllowedAt()).toISOString(),
  };
}

// ── the loop ─────────────────────────────────────────────────────────────────

export interface ArcticShiftWorkerHandle {
  /** Run one cycle now, respecting the rate guard. */
  runOnce: () => Promise<CycleMetrics | null>;
  /** Loop until `stop()` — resolves once the loop has fully stopped. */
  start: () => Promise<void>;
  stop: () => void;
  isRunning: () => boolean;
}

export interface ArcticShiftWorkerOptions extends ArcticShiftCycleDeps {
  /** Identifies this process in the distributed lease. */
  instanceId?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Wrapper used to record the cycle in `worker_runs`. */
  recordRun?: (
    name: string,
    run: () => Promise<CycleMetrics>,
  ) => Promise<CycleMetrics | null>;
}

/**
 * The sequential loop.
 *
 * NOT `setInterval`: an interval fires on a schedule that knows nothing about
 * how long the previous run took, and two overlapping cycles would mean two
 * concurrent requests. This awaits each cycle, then sleeps whatever is left of
 * the interval. Concurrency is refused twice over — an in-process flag for this
 * instance, and a database lease for the case where Render runs two.
 */
export function createArcticShiftWorker(
  options: ArcticShiftWorkerOptions,
): ArcticShiftWorkerHandle {
  const config = options.config ?? redditConfig;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const instanceId = options.instanceId ?? `${process.pid}@${hostname()}`;
  const workerName = options.scheduler.workerName;

  let requestInProgress = false;
  let stopped = false;

  const runOnce = async (): Promise<CycleMetrics | null> => {
    if (requestInProgress) {
      console.warn(
        "[ArcticShiftWorker] Skipping Arctic Shift cycle because another request is active",
      );
      return null;
    }
    requestInProgress = true;

    // The lease covers slightly more than one interval, so a crashed instance
    // frees the rotation without a human.
    const leaseMs = config.pollIntervalMs + 60_000;
    let leased = false;

    try {
      leased = await options.store.acquireLease(workerName, instanceId, leaseMs);
      if (!leased) {
        console.warn(
          "[ArcticShiftWorker] Another instance holds the worker lease; skipping this cycle.",
        );
        return null;
      }

      const run = (): Promise<CycleMetrics> => runArcticShiftCycle(options);
      return options.recordRun
        ? await options.recordRun("arcticShiftCycle", run)
        : await run();
    } finally {
      if (leased) {
        try {
          await options.store.releaseLease(workerName, instanceId);
        } catch (error) {
          console.error(
            `[ArcticShiftWorker] could not release the lease: ${sanitizeProviderError(error)}`,
          );
        }
      }
      requestInProgress = false;
    }
  };

  const start = async (): Promise<void> => {
    while (!stopped) {
      const cycleStartedAt = now();
      await runOnce();
      if (stopped) break;

      const elapsed = now() - cycleStartedAt;
      const waitMs = Math.max(config.pollIntervalMs - elapsed, 0);
      await sleep(waitMs);
    }
  };

  return {
    runOnce,
    start,
    stop: () => {
      stopped = true;
    },
    isRunning: () => requestInProgress,
  };
}

function hostname(): string {
  try {
    // Lazy so the module stays importable in a browser-less test runner.
    return process.env.RENDER_INSTANCE_ID ?? process.env.HOSTNAME ?? "local";
  } catch {
    return "local";
  }
}

export { ARCTIC_SHIFT_WORKER_NAME, ArcticShiftScheduler, ArcticShiftRateGuard };
