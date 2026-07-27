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
 */
export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (err) {
    console.error(
      "[prisma] error during disconnect:",
      err instanceof Error ? err.message : err,
    );
  }
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
export function registerPrismaShutdown(
  label: string,
  onSignal?: (signal: string) => Promise<void> | void,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
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

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
