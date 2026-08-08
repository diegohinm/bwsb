import { PrismaClient } from "@prisma/client";
import { isProduction } from "../config/env.js";

/**
 * The one Prisma client for this project.
 *
 * SERVER-SIDE ONLY. Connects with DATABASE_URL, which is never exposed to the
 * frontend. Every consumer — the Express API, the ingestion worker, jobs,
 * repositories and scripts — imports THIS instance. Never construct a
 * PrismaClient in a route, repository or job: each one opens its own connection
 * pool, and Supabase's connection limit is quickly exhausted.
 *
 * Cached on globalThis in development so tsx's watch-mode reloads reuse a single
 * pool instead of leaking one per restart.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ["error"] : ["error", "warn"],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * Close the connection pool. Safe to call more than once.
 *
 * Called from the API and worker shutdown handlers so a SIGTERM (a Render
 * redeploy, a local Ctrl-C) returns connections to Supabase instead of leaving
 * them to time out.
 *
 * IDEMPOTENT BY LATCH, not just by Prisma's own tolerance: the promise of the
 * first call is reused, so two shutdown paths racing each other produce one
 * disconnect rather than two. Long-running processes must never call this
 * outside shutdown — a `$disconnect` after each request or job forces the next
 * caller to reopen a pooler session, which is the opposite of what a shared
 * pool is for.
 */
let disconnectPromise: Promise<void> | null = null;

export async function disconnectPrisma(): Promise<void> {
  disconnectPromise ??= prisma
    .$disconnect()
    .catch((err: unknown) =>
      console.error(
        "[prisma] error during disconnect:",
        err instanceof Error ? err.message : err,
      ),
    )
    .then(() => undefined);
  return disconnectPromise;
}

/** Test seam: forget that a disconnect happened. */
export function resetDisconnectLatchForTests(): void {
  disconnectPromise = null;
}

/**
 * Register SIGTERM/SIGINT handlers that disconnect Prisma and then exit.
 *
 * `beforeExit` is deliberately not used: it does not fire on signals, and Prisma
 * removed its own `beforeExit` hook in v5.
 *
 * @param label     Process name used in shutdown logs ("api", "worker").
 * @param onSignal  Optional process-specific cleanup, awaited BEFORE Prisma is
 *                  disconnected so in-flight work can still write to the
 *                  database.
 */
let shutdownRegistered = false;

export function registerPrismaShutdown(
  label: string,
  onSignal?: (signal: string) => Promise<void> | void,
): void {
  // ONE registration per process. A second call — from a stray import, a test
  // that loads the entrypoint twice — would add a second pair of handlers and
  // run the whole teardown twice.
  if (shutdownRegistered) {
    console.warn(`[${label}] shutdown handlers already registered — ignoring duplicate call`);
    return;
  }
  shutdownRegistered = true;

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      // Schedulers and servers stop FIRST, while the pool is still open, so
      // in-flight work can finish its writes.
      await onSignal?.(signal);
    } catch (err) {
      console.error(
        `[${label}] error during shutdown:`,
        err instanceof Error ? err.message : err,
      );
    }

    await disconnectPrisma();
    console.log(`[${label}] stopped (${signal}).`);
    process.exit(0);
  };

  // `once`, not `on`: a second Ctrl-C should reach the default handler and kill
  // a wedged process rather than being swallowed by the in-progress shutdown.
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

/** Test seam: allow a fresh registration. */
export function resetShutdownRegistrationForTests(): void {
  shutdownRegistered = false;
}

/**
 * Last-resort logging for promises nobody handled.
 *
 * This is a NET, NOT A FIX. Every known floating promise in this codebase has
 * its own catch; if this handler ever fires in normal operation, that is a bug
 * to find, not a condition to tolerate. It exists so the failure is named in
 * the log instead of arriving as a bare stack trace, and — for an uncaught
 * exception, where the process state really is unknown — so shutdown is
 * orderly rather than abrupt.
 */
export function registerProcessSafetyNet(label: string): void {
  process.on("unhandledRejection", (reason) => {
    console.error(
      `[${label}] unhandled rejection — this is a bug, not an expected condition:`,
      reason instanceof Error ? `${reason.name}: ${reason.message}` : reason,
    );
  });

  process.on("uncaughtException", (err) => {
    console.error(`[${label}] uncaught exception:`, err);
    void disconnectPrisma().finally(() => process.exit(1));
  });
}
