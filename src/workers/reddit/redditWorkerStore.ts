import { prisma } from "../../lib/prisma.js";

/**
 * Durable state for the Reddit ingestion worker: rotation, pacing, cursors.
 *
 * WHY AN INTERFACE
 * The worker's guarantees — one request per five minutes, at most twelve per
 * hour, a cursor that only moves after a successful write — are all timing and
 * ordering rules. Tests must be able to drive them without a database and
 * without waiting five real minutes, so the worker depends on
 * `RedditWorkerStore`, never on Prisma directly. `prismaRedditWorkerStore` is
 * the production implementation; tests pass an in-memory one.
 *
 * WHY RAW SQL
 * These two tables are written by exactly one process and read as whole rows.
 * Parameterized `$queryRaw` keeps the repository working the moment the
 * migration lands, without waiting on a client regeneration — the models are in
 * `prisma/schema.prisma` and the columns are identical. Every value is bound as
 * a parameter; nothing is interpolated into SQL text.
 */

export interface RedditWorkerStateRow {
  workerName: string;
  nextSubredditIndex: number;
  /** When the last upstream request STARTED. The 5-minute gate reads this. */
  lastRequestAt: Date | null;
  lastSuccessfulRunAt: Date | null;
  consecutiveFailures: number;
  /** Set from a 429's Retry-After; no request may leave before it passes. */
  blockedUntil: Date | null;
  /** ISO timestamps of requests in the last hour, oldest first. */
  requestLog: string[];
}

export interface RedditIngestionCursorRow {
  provider: string;
  subreddit: string;
  contentType: string;
  lastCreatedAt: Date | null;
  lastExternalId: string | null;
  lastSuccessfulSyncAt: Date | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  hasMore: boolean;
  cooldownUntil: Date | null;
}

export interface CursorSuccessUpdate {
  /** Newest createdAt actually persisted, or null to leave the cursor alone. */
  lastCreatedAt: Date | null;
  lastExternalId: string | null;
  hasMore: boolean;
  syncedAt: Date;
}

export interface CursorFailureUpdate {
  errorCode: string;
  errorMessage: string;
  attemptedAt: Date;
  /** Set when the failure count crossed the cooldown threshold. */
  cooldownUntil?: Date | null;
}

export interface RedditWorkerStore {
  loadState(workerName: string): Promise<RedditWorkerStateRow>;
  setNextSubredditIndex(workerName: string, index: number): Promise<void>;
  /** Persist "a request is leaving now", including the pruned hour log. */
  recordRequestStarted(
    workerName: string,
    at: Date,
    requestLog: string[],
  ): Promise<void>;
  setBlockedUntil(workerName: string, until: Date | null): Promise<void>;
  recordCycleOutcome(
    workerName: string,
    outcome: { success: boolean; at: Date },
  ): Promise<void>;

  getCursor(
    provider: string,
    subreddit: string,
    contentType: string,
  ): Promise<RedditIngestionCursorRow | null>;
  recordCursorAttempt(
    provider: string,
    subreddit: string,
    contentType: string,
    at: Date,
  ): Promise<void>;
  recordCursorSuccess(
    provider: string,
    subreddit: string,
    contentType: string,
    update: CursorSuccessUpdate,
  ): Promise<void>;
  recordCursorFailure(
    provider: string,
    subreddit: string,
    contentType: string,
    update: CursorFailureUpdate,
  ): Promise<void>;

  /**
   * Take the right to run a cycle for `leaseMs`, or return false.
   *
   * A LEASE, NOT `pg_advisory_lock`: the Supabase transaction pooler hands the
   * same connection to different callers, so a session-scoped advisory lock has
   * no owner worth speaking of. A compare-and-swap on (locked_by, locked_until)
   * is pooler-safe, and a worker that dies mid-cycle stops blocking the others
   * the moment its lease expires.
   */
  acquireLease(workerName: string, owner: string, leaseMs: number): Promise<boolean>;
  releaseLease(workerName: string, owner: string): Promise<void>;
}

// ── Prisma implementation ────────────────────────────────────────────────────

interface StateRecord {
  worker_name: string;
  next_subreddit_index: number;
  last_request_at: Date | null;
  last_successful_run_at: Date | null;
  consecutive_failures: number;
  blocked_until: Date | null;
  request_log: unknown;
}

interface CursorRecord {
  provider: string;
  subreddit: string;
  content_type: string;
  last_created_at: Date | null;
  last_external_id: string | null;
  last_successful_sync_at: Date | null;
  last_error_code: string | null;
  consecutive_failures: number;
  has_more: boolean;
  cooldown_until: Date | null;
}

function toStateRow(record: StateRecord): RedditWorkerStateRow {
  return {
    workerName: record.worker_name,
    nextSubredditIndex: record.next_subreddit_index,
    lastRequestAt: record.last_request_at,
    lastSuccessfulRunAt: record.last_successful_run_at,
    consecutiveFailures: record.consecutive_failures,
    blockedUntil: record.blocked_until,
    requestLog: Array.isArray(record.request_log)
      ? record.request_log.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function toCursorRow(record: CursorRecord): RedditIngestionCursorRow {
  return {
    provider: record.provider,
    subreddit: record.subreddit,
    contentType: record.content_type,
    lastCreatedAt: record.last_created_at,
    lastExternalId: record.last_external_id,
    lastSuccessfulSyncAt: record.last_successful_sync_at,
    lastErrorCode: record.last_error_code,
    consecutiveFailures: record.consecutive_failures,
    hasMore: record.has_more,
    cooldownUntil: record.cooldown_until,
  };
}

export const prismaRedditWorkerStore: RedditWorkerStore = {
  async loadState(workerName) {
    await prisma.$executeRaw`
      INSERT INTO reddit_worker_state (worker_name)
      VALUES (${workerName})
      ON CONFLICT (worker_name) DO NOTHING
    `;
    const rows = await prisma.$queryRaw<StateRecord[]>`
      SELECT worker_name, next_subreddit_index, last_request_at,
             last_successful_run_at, consecutive_failures, blocked_until, request_log
      FROM reddit_worker_state
      WHERE worker_name = ${workerName}
    `;
    const record = rows[0];
    if (!record) {
      throw new Error(`reddit_worker_state row for "${workerName}" could not be created.`);
    }
    return toStateRow(record);
  },

  async setNextSubredditIndex(workerName, index) {
    await prisma.$executeRaw`
      UPDATE reddit_worker_state
      SET next_subreddit_index = ${index}, updated_at = now()
      WHERE worker_name = ${workerName}
    `;
  },

  async recordRequestStarted(workerName, at, requestLog) {
    await prisma.$executeRaw`
      UPDATE reddit_worker_state
      SET last_request_at = ${at},
          request_log = ${JSON.stringify(requestLog)}::jsonb,
          updated_at = now()
      WHERE worker_name = ${workerName}
    `;
  },

  async setBlockedUntil(workerName, until) {
    await prisma.$executeRaw`
      UPDATE reddit_worker_state
      SET blocked_until = ${until}, updated_at = now()
      WHERE worker_name = ${workerName}
    `;
  },

  async recordCycleOutcome(workerName, outcome) {
    if (outcome.success) {
      await prisma.$executeRaw`
        UPDATE reddit_worker_state
        SET last_successful_run_at = ${outcome.at},
            consecutive_failures = 0,
            updated_at = now()
        WHERE worker_name = ${workerName}
      `;
      return;
    }
    await prisma.$executeRaw`
      UPDATE reddit_worker_state
      SET consecutive_failures = consecutive_failures + 1, updated_at = now()
      WHERE worker_name = ${workerName}
    `;
  },

  async getCursor(provider, subreddit, contentType) {
    const rows = await prisma.$queryRaw<CursorRecord[]>`
      SELECT provider, subreddit, content_type, last_created_at, last_external_id,
             last_successful_sync_at, last_error_code, consecutive_failures,
             has_more, cooldown_until
      FROM reddit_ingestion_cursors
      WHERE provider = ${provider}
        AND subreddit = ${subreddit}
        AND content_type = ${contentType}
    `;
    const record = rows[0];
    return record ? toCursorRow(record) : null;
  },

  async recordCursorAttempt(provider, subreddit, contentType, at) {
    await prisma.$executeRaw`
      INSERT INTO reddit_ingestion_cursors (provider, subreddit, content_type, last_attempt_at)
      VALUES (${provider}, ${subreddit}, ${contentType}, ${at})
      ON CONFLICT (provider, subreddit, content_type)
      DO UPDATE SET last_attempt_at = ${at}, updated_at = now()
    `;
  },

  async recordCursorSuccess(provider, subreddit, contentType, update) {
    // COALESCE keeps an existing cursor when the batch was empty: an archive
    // with indexing lag must never have its window skipped forward to "now".
    await prisma.$executeRaw`
      INSERT INTO reddit_ingestion_cursors (
        provider, subreddit, content_type, last_created_at, last_external_id,
        last_successful_sync_at, has_more, consecutive_failures,
        last_error_code, last_error_message, cooldown_until
      )
      VALUES (
        ${provider}, ${subreddit}, ${contentType}, ${update.lastCreatedAt},
        ${update.lastExternalId}, ${update.syncedAt}, ${update.hasMore}, 0, NULL, NULL, NULL
      )
      ON CONFLICT (provider, subreddit, content_type)
      DO UPDATE SET
        last_created_at = COALESCE(${update.lastCreatedAt}, reddit_ingestion_cursors.last_created_at),
        last_external_id = COALESCE(${update.lastExternalId}, reddit_ingestion_cursors.last_external_id),
        last_successful_sync_at = ${update.syncedAt},
        has_more = ${update.hasMore},
        consecutive_failures = 0,
        last_error_code = NULL,
        last_error_message = NULL,
        cooldown_until = NULL,
        updated_at = now()
    `;
  },

  async recordCursorFailure(provider, subreddit, contentType, update) {
    const cooldownUntil = update.cooldownUntil ?? null;
    await prisma.$executeRaw`
      INSERT INTO reddit_ingestion_cursors (
        provider, subreddit, content_type, last_attempt_at,
        last_error_code, last_error_message, consecutive_failures, cooldown_until
      )
      VALUES (
        ${provider}, ${subreddit}, ${contentType}, ${update.attemptedAt},
        ${update.errorCode}, ${update.errorMessage}, 1, ${cooldownUntil}
      )
      ON CONFLICT (provider, subreddit, content_type)
      DO UPDATE SET
        last_attempt_at = ${update.attemptedAt},
        last_error_code = ${update.errorCode},
        last_error_message = ${update.errorMessage},
        consecutive_failures = reddit_ingestion_cursors.consecutive_failures + 1,
        cooldown_until = COALESCE(${cooldownUntil}, reddit_ingestion_cursors.cooldown_until),
        updated_at = now()
    `;
  },

  async acquireLease(workerName, owner, leaseMs) {
    const seconds = Math.ceil(leaseMs / 1000);
    // `make_interval` takes the duration as a BOUND parameter — no SQL text is
    // ever built from a value.
    const affected = await prisma.$executeRaw`
      UPDATE reddit_worker_state
      SET locked_by = ${owner},
          locked_until = now() + make_interval(secs => ${seconds}),
          updated_at = now()
      WHERE worker_name = ${workerName}
        AND (locked_until IS NULL OR locked_until < now() OR locked_by = ${owner})
    `;
    return affected > 0;
  },

  async releaseLease(workerName, owner) {
    await prisma.$executeRaw`
      UPDATE reddit_worker_state
      SET locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE worker_name = ${workerName} AND locked_by = ${owner}
    `;
  },
};
