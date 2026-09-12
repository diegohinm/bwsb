import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { increment } from "../../lib/metrics.js";

/**
 * THE MARKET-DATA WORK QUEUE.
 *
 * WHAT IT REPLACED. Market refresh was a hardcoded list of sixteen symbols on a
 * five-minute timer. Every symbol cost the same whether anyone was looking at
 * it, and a symbol absent from the list was never refreshed however loudly
 * Reddit was talking about it. Demand and supply had no connection.
 *
 * WHAT A ROW MEANS. "Somebody would like this symbol's market data, this badly."
 * It is a request, not a promise: the worker decides when, batches what it can,
 * and NOTHING ON A READ PATH EVER WAITS FOR ONE. An API request may enqueue a
 * job and must then return the data it already has — see marketRead.service.
 *
 * WHY POSTGRES AND NOT A BROKER. The single hard guarantee a queue needs here is
 * that two workers cannot claim the same row. `FOR UPDATE SKIP LOCKED` provides
 * it natively, inside the transaction that also marks the row PROCESSING, so the
 * claim and the state change cannot come apart. Redis or RabbitMQ would add an
 * operational dependency to buy something already present.
 */

export const MARKET_JOB_TYPES = ["QUOTE", "SNAPSHOT", "CANDLES"] as const;
export type MarketJobType = (typeof MARKET_JOB_TYPES)[number];

export const MARKET_JOB_STATUSES = ["PENDING", "PROCESSING", "DONE", "FAILED"] as const;
export type MarketJobStatus = (typeof MARKET_JOB_STATUSES)[number];

/**
 * WHO GETS REFRESHED FIRST. Lower is sooner.
 *
 * Not every symbol deserves the same attention, and pretending otherwise is what
 * made the old fixed list both wasteful and inadequate at once. A ticker page
 * someone has open right now and a symbol mentioned twice yesterday are
 * different requests, and the queue is where that difference gets expressed.
 */
export const MARKET_PRIORITY = {
  /** A page is open on it, or it is in somebody's portfolio or watchlist. */
  REALTIME: 1,
  /** Ranked in Top or Hot Tickers — about to be looked at, statistically. */
  TRENDING: 2,
  /** Mentioned on Reddit recently. The long tail worth keeping warm. */
  ACTIVE: 3,
  /** Housekeeping: gap fills, cold symbols, anything with no reader waiting. */
  BACKGROUND: 4,
} as const;

export type MarketPriority = (typeof MARKET_PRIORITY)[keyof typeof MARKET_PRIORITY];

/**
 * How long an open job suppresses an identical one.
 *
 * Deduplication is not merely a tidiness measure: the enqueue points are a read
 * path and a scheduled sweep, both of which fire repeatedly on the same symbols.
 * Twenty people opening the NVDA page in a minute is one refresh, not twenty.
 */
const DEDUPE_WINDOW_MS = 2 * 60_000;

/**
 * How long a PROCESSING row may sit before it is presumed abandoned.
 *
 * A worker killed mid-job leaves its claim behind; without this the symbol would
 * be permanently un-refreshable, because deduplication would keep treating the
 * orphan as work in flight.
 */
const STUCK_AFTER_MS = 10 * 60_000;

/** Retry backoff, by attempt number. Past the end, the job is given up on. */
const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000];
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

export type EnqueueInput = {
  ticker: string;
  jobType: MarketJobType;
  priority?: MarketPriority;
  /** Candle interval and range. Ignored for QUOTE/SNAPSHOT. */
  params?: Record<string, unknown>;
};

export type MarketDataJobRow = {
  id: string;
  ticker: string;
  jobType: MarketJobType;
  priority: number;
  attempts: number;
  params: Prisma.JsonValue;
};

/**
 * Ask for a symbol's market data.
 *
 * Returns the id of the job that will carry the request — which may be one that
 * already existed. Deduplication is done in SQL rather than read-then-write, so
 * two API processes enqueuing the same symbol in the same instant produce one
 * job rather than racing to discover each other.
 *
 * AN EXISTING OPEN JOB IS PROMOTED, NOT DUPLICATED. If a background gap-fill for
 * NVDA is already queued and somebody then opens the NVDA page, the right answer
 * is to make the queued job urgent — not to add a second one behind it.
 */
export async function enqueueMarketDataJob(input: EnqueueInput): Promise<string | null> {
  if (!env.MARKET_DATA_QUEUE_ENABLED) return null;

  const ticker = input.ticker.trim().toUpperCase();
  if (!ticker) return null;

  const priority = input.priority ?? MARKET_PRIORITY.ACTIVE;
  // SERIALIZED HERE, bound as text and cast in SQL. A raw query parameter is
  // sent to the driver as-is, and a plain JS object has no wire representation
  // it can use — binding one fails at the driver, not at compile time.
  const params = JSON.stringify(input.params ?? {});
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);

  const rows = await prisma.$queryRaw<{ id: string; inserted: boolean }[]>(Prisma.sql`
    WITH existing AS (
      -- Open work for this symbol. A PROCESSING row counts only while it is
      -- plausibly still being worked on; past that it is an orphaned claim and
      -- must not keep suppressing new requests forever.
      SELECT id FROM market_data_jobs
       WHERE ticker = ${ticker}
         AND job_type = ${input.jobType}
         AND (
              (status = 'PENDING' AND requested_at >= ${since})
           OR (status = 'PROCESSING' AND started_at >= ${new Date(Date.now() - STUCK_AFTER_MS)})
         )
       ORDER BY requested_at DESC
       LIMIT 1
    ),
    promoted AS (
      UPDATE market_data_jobs j
         SET priority = LEAST(j.priority, ${priority}), updated_at = now()
        FROM existing e
       WHERE j.id = e.id AND j.priority > ${priority}
      RETURNING j.id
    ),
    inserted AS (
      INSERT INTO market_data_jobs (ticker, job_type, priority, status, params)
      SELECT ${ticker}, ${input.jobType}, ${priority}, 'PENDING', ${params}::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id
    )
    SELECT id, true  AS inserted FROM inserted
    UNION ALL
    SELECT id, false AS inserted FROM existing
    LIMIT 1`);

  const row = rows[0];
  if (!row) return null;
  increment(row.inserted ? "market_jobs_enqueued" : "market_jobs_deduplicated");
  return row.id;
}

/** Enqueue many at once. Sequential: each one's dedupe must see the last one's insert. */
export async function enqueueMarketDataJobs(inputs: EnqueueInput[]): Promise<number> {
  let enqueued = 0;
  for (const input of inputs) {
    try {
      if (await enqueueMarketDataJob(input)) enqueued += 1;
    } catch (err) {
      // One bad symbol must not abort a sweep over hundreds.
      console.error(`[market-queue] enqueue failed for ${input.ticker}:`, err);
    }
  }
  return enqueued;
}

/**
 * Claim up to `limit` jobs for this worker.
 *
 * THE ONE QUERY THAT HAS TO BE RAW. `FOR UPDATE SKIP LOCKED` is the entire
 * concurrency story and Prisma's query builder cannot express it: two workers
 * running this simultaneously each get a disjoint set, because the second skips
 * the rows the first has locked rather than blocking on them or — far worse —
 * reading them as available. The UPDATE to PROCESSING happens in the same
 * statement, so a claim cannot be granted without being recorded.
 *
 * ORDERING: priority ascending (1 is most urgent), then oldest request first, so
 * a steady stream of urgent work cannot starve a low-priority job indefinitely
 * within its own priority band.
 */
export async function claimMarketDataJobs(limit: number): Promise<MarketDataJobRow[]> {
  const now = new Date();

  const rows = await prisma.$queryRaw<
    {
      id: string;
      ticker: string;
      job_type: MarketJobType;
      priority: number;
      attempts: number;
      params: Prisma.JsonValue;
    }[]
  >(Prisma.sql`
    WITH claimed AS (
      SELECT id
        FROM market_data_jobs
       WHERE status = 'PENDING'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
       ORDER BY priority ASC, requested_at ASC
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE market_data_jobs j
       SET status = 'PROCESSING', started_at = ${now}, attempts = j.attempts + 1, updated_at = now()
      FROM claimed c
     WHERE j.id = c.id
    RETURNING j.id, j.ticker, j.job_type, j.priority, j.attempts, j.params`);

  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    jobType: r.job_type,
    priority: r.priority,
    attempts: r.attempts,
    params: r.params,
  }));
}

export async function completeMarketDataJobs(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const n = await prisma.marketDataJob.updateMany({
    where: { id: { in: ids } },
    data: { status: "DONE", processedAt: new Date(), error: null },
  });
  increment("market_jobs_processed", n.count);
  return n.count;
}

/**
 * Record a failure, and decide whether it gets another go.
 *
 * A retryable failure goes back to PENDING behind a backoff — it is invisible to
 * the claim query until `next_attempt_at` passes, which gives the queue retry
 * scheduling without a scheduler. Past the last backoff it is marked FAILED and
 * left alone: a symbol the provider genuinely cannot serve must stop consuming
 * a worker slot every twenty seconds forever.
 */
export async function failMarketDataJobs(ids: string[], message: string): Promise<number> {
  if (ids.length === 0) return 0;
  const error = message.slice(0, 500);
  const now = Date.now();

  const jobs = await prisma.marketDataJob.findMany({
    where: { id: { in: ids } },
    select: { id: true, attempts: true },
  });

  let failed = 0;
  for (const job of jobs) {
    const backoff = RETRY_BACKOFF_MS[job.attempts - 1];
    const giveUp = backoff === undefined;
    await prisma.marketDataJob.update({
      where: { id: job.id },
      data: {
        status: giveUp ? "FAILED" : "PENDING",
        error,
        processedAt: giveUp ? new Date(now) : null,
        nextAttemptAt: giveUp ? null : new Date(now + backoff),
      },
    });
    if (giveUp) failed += 1;
  }

  increment("market_jobs_failed", ids.length);
  return failed;
}

/**
 * Return abandoned claims to the queue.
 *
 * A worker that dies mid-job leaves a PROCESSING row nobody owns. Without this
 * sweep the symbol becomes permanently un-refreshable: deduplication keeps
 * treating the orphan as work in flight, so no replacement job is ever created.
 * Run at the top of each drain — it is one indexed UPDATE.
 */
export async function releaseStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
  const n = await prisma.marketDataJob.updateMany({
    where: { status: "PROCESSING", startedAt: { lt: cutoff } },
    data: { status: "PENDING", startedAt: null, error: "reclaimed: worker did not finish" },
  });
  if (n.count > 0) console.warn(`[market-queue] reclaimed ${n.count} abandoned job(s)`);
  return n.count;
}

export type QueueDepth = { pending: number; processing: number; failed: number };

/** For the health endpoint: is work piling up faster than it is being done? */
export async function queueDepth(): Promise<QueueDepth> {
  const rows = await prisma.marketDataJob.groupBy({
    by: ["status"],
    _count: { _all: true },
    where: { status: { in: ["PENDING", "PROCESSING", "FAILED"] } },
  });
  const depth: QueueDepth = { pending: 0, processing: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "PENDING") depth.pending = row._count._all;
    else if (row.status === "PROCESSING") depth.processing = row._count._all;
    else if (row.status === "FAILED") depth.failed = row._count._all;
  }
  return depth;
}
