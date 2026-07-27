import { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

/**
 * Worker run log. Every ingestion job writes exactly one row per execution, so
 * GET /api/ingestion/status can answer "is the worker alive, when did each feed
 * last succeed, and what failed" without the API touching a provider.
 *
 * Never store secrets: only job names, timings, counts and sanitized messages.
 */

/**
 * Run outcomes.
 *
 *   success                → the job did its work
 *   success_without_change  → ran fine, nothing to update (e.g. no new bar)
 *   skipped_market_closed   → nothing to do because the market is closed
 *   skipped                 → a tick fired while the previous run was in flight
 *   error                   → the job genuinely failed
 *
 * Everything except `error` is a healthy outcome; a quiet market must never be
 * reported as an outage.
 */
export type WorkerRunStatus =
  | "success"
  | "success_without_change"
  | "skipped_market_closed"
  | "skipped"
  | "error";

/** Statuses that mean "the job ran fine", used by the status endpoint. */
export const HEALTHY_RUN_STATUSES: WorkerRunStatus[] = [
  "success",
  "success_without_change",
  "skipped_market_closed",
];

export interface WorkerRunInput {
  workerName: string;
  jobName: string;
  status: WorkerRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordWorkerRun(run: WorkerRunInput): Promise<void> {
  await prisma.workerRuns.create({
    data: {
      workerName: run.workerName,
      jobName: run.jobName,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      errorMessage: run.errorMessage ?? null,
      // DbNull writes a SQL NULL; JsonNull would write the JSON value `null`.
      metadata: (run.metadata ?? Prisma.DbNull) as Prisma.InputJsonValue,
    },
  });
}

export interface WorkerRunRow {
  jobName: string;
  workerName: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
}

/** Columns the status endpoint needs — deliberately not `id` or `created_at`. */
const SELECT_COLUMNS = {
  jobName: true,
  workerName: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  errorMessage: true,
  metadata: true,
} satisfies Prisma.WorkerRunsSelect;

type SelectedRun = Prisma.WorkerRunsGetPayload<{ select: typeof SELECT_COLUMNS }>;

function toRow(r: SelectedRun): WorkerRunRow {
  return {
    jobName: r.jobName,
    workerName: r.workerName,
    status: r.status,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    durationMs: r.durationMs,
    errorMessage: r.errorMessage,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Most recent run per job, whatever its status.
 *
 * Two queries rather than one `DISTINCT ON`: group to find each job's newest
 * `created_at`, then fetch exactly those rows. Reading every row and filtering
 * in memory would get slower with every worker tick.
 */
export async function readLatestRunPerJob(): Promise<WorkerRunRow[]> {
  const newestPerJob = await prisma.workerRuns.groupBy({
    by: ["jobName"],
    _max: { createdAt: true },
  });

  const keys = newestPerJob
    .filter((g): g is typeof g & { _max: { createdAt: Date } } => g._max.createdAt !== null)
    .map((g) => ({ jobName: g.jobName, createdAt: g._max.createdAt }));

  if (keys.length === 0) return [];

  const rows = await prisma.workerRuns.findMany({
    where: { OR: keys },
    select: SELECT_COLUMNS,
    orderBy: { jobName: "asc" },
  });

  // Two runs of one job can share a created_at to the microsecond; keep one.
  const seen = new Set<string>();
  return rows
    .filter((r) => !seen.has(r.jobName) && seen.add(r.jobName) !== undefined)
    .map(toRow);
}

/**
 * Most recent HEALTHY run of one job, or null. "Healthy" includes runs that had
 * nothing to do (quiet market), so a weekend does not look like a dead worker.
 */
export async function readLastSuccess(jobName: string): Promise<WorkerRunRow | null> {
  const row = await prisma.workerRuns.findFirst({
    where: { jobName, status: { in: HEALTHY_RUN_STATUSES } },
    select: SELECT_COLUMNS,
    orderBy: { createdAt: "desc" },
  });
  return row ? toRow(row) : null;
}

/** Most recent failures across all jobs (newest first). */
export async function readRecentErrors(limit = 5): Promise<WorkerRunRow[]> {
  const rows = await prisma.workerRuns.findMany({
    where: { status: "error" },
    select: SELECT_COLUMNS,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRow);
}
