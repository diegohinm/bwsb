import { pathToFileURL } from "node:url";

import { WORKER_NAME } from "../config/ingestion.js";
import { disconnectPrisma } from "./prisma.js";
import {
  recordWorkerRun,
  type WorkerRunStatus,
} from "../repositories/workerRuns.repository.js";

/**
 * Scheduling primitives for the ingestion worker.
 *
 * Guarantees:
 *   - EVERY execution writes exactly one `worker_runs` row (success or error),
 *     so /api/ingestion/status can report worker health without guessing.
 *   - NO OVERLAP: a tick that fires while the previous run is still in flight is
 *     skipped and logged, never queued. Providers are metered — a slow social
 *     sweep must not stack up behind itself.
 *   - A failing job never crashes the process: errors are caught, recorded and
 *     the loop continues on the next tick.
 */

/**
 * What a job returns for the run log. Must not contain secrets.
 *
 * A job may set the reserved `status` key to report a healthy non-default
 * outcome — `success_without_change` (ran fine, nothing to update) or
 * `skipped_market_closed`. Anything else defaults to `success`; failures are
 * signalled by throwing. The key is stripped from the stored metadata.
 */
export type JobMetadata = Record<string, unknown>;

export type JobFn = () => Promise<JobMetadata | void>;

/** Healthy statuses a job may self-report via the reserved `status` key. */
const JOB_REPORTABLE_STATUSES: WorkerRunStatus[] = [
  "success",
  "success_without_change",
  "skipped_market_closed",
];

/** Split a job's return value into its self-reported status and its metadata. */
function splitOutcome(raw: JobMetadata | undefined): {
  status: WorkerRunStatus;
  metadata: JobMetadata | undefined;
} {
  if (!raw) return { status: "success", metadata: undefined };
  const { status, ...metadata } = raw;
  const reported =
    typeof status === "string" &&
    (JOB_REPORTABLE_STATUSES as string[]).includes(status)
      ? (status as WorkerRunStatus)
      : "success";
  return {
    status: reported,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/** Strip anything secret-looking before a message reaches the log or the DB. */
function sanitize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|secret|password)=[^\s&]+/gi, "$1=***");
}

/**
 * Run a job once, timing it and recording the outcome in `worker_runs`.
 * Returns true when the job succeeded. Never throws.
 */
export async function runJobOnce(name: string, fn: JobFn): Promise<boolean> {
  const startedAt = new Date();
  try {
    const { status, metadata } = splitOutcome((await fn()) ?? undefined);
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    console.log(
      `[worker] ${name}: ${status} in ${durationMs}ms${
        metadata ? ` ${JSON.stringify(metadata)}` : ""
      }`,
    );
    await safeRecord({
      workerName: WORKER_NAME,
      jobName: name,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      metadata: metadata ?? null,
    });
    return true;
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const message = sanitize(err);
    console.error(`[worker] ${name}: FAILED after ${durationMs}ms — ${message}`);
    await safeRecord({
      workerName: WORKER_NAME,
      jobName: name,
      status: "error",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      errorMessage: message,
    });
    return false;
  }
}

/**
 * Run a job once as a standalone script (`npm run market:refresh`), then close
 * the Prisma pool and exit with the job's outcome.
 *
 * The scheduled path must NOT do this: inside the worker the pool is shared by
 * every loop and stays open until shutdown.
 */
export async function runJobAsScript(name: string, fn: JobFn): Promise<never> {
  const ok = await runJobOnce(name, fn);
  await disconnectPrisma();
  process.exit(ok ? 0 : 1);
}

/**
 * Record a run without ever letting a logging failure take down the worker —
 * a database blip must not turn into a crash loop.
 */
async function safeRecord(run: Parameters<typeof recordWorkerRun>[0]): Promise<void> {
  try {
    await recordWorkerRun(run);
  } catch (err) {
    console.error(
      `[worker] could not write worker_runs for ${run.jobName}: ${sanitize(err)}`,
    );
  }
}

export interface JobLoopHandle {
  name: string;
  /** Stop scheduling. An in-flight run is awaited by the caller if needed. */
  stop: () => void;
  /** True while a run is in flight. */
  isRunning: () => boolean;
}

/**
 * Start a job on a fixed interval. The first run fires immediately (after an
 * optional stagger) so a fresh deploy fills the tables without waiting a full
 * interval.
 */
export function startJobLoop(options: {
  name: string;
  intervalSeconds: number;
  run: JobFn;
  /** Delay the first execution, used to stagger jobs on boot. */
  initialDelayMs?: number;
}): JobLoopHandle {
  const { name, intervalSeconds, run, initialDelayMs = 0 } = options;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      // Previous run still in flight — skip this tick rather than pile up.
      console.warn(`[worker] ${name}: previous run still active, skipping tick`);
      await safeRecord({
        workerName: WORKER_NAME,
        jobName: name,
        status: "skipped",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        errorMessage: "Previous run still active",
      });
      return;
    }
    running = true;
    try {
      await runJobOnce(name, run);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), intervalSeconds * 1000);
  // Don't keep the event loop alive purely for the timer during shutdown.
  interval.unref?.();
  const firstRun = setTimeout(() => void tick(), initialDelayMs);
  firstRun.unref?.();

  console.log(`[worker] scheduled ${name} every ${intervalSeconds}s`);

  return {
    name,
    stop: () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(firstRun);
    },
    isRunning: () => running,
  };
}

/** True when `importMetaUrl`'s module was executed directly (not imported). */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return importMetaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
