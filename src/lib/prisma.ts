import { PrismaClient } from "@prisma/client";
import { isProduction } from "../config/env.js";

/**
 * Shared Prisma client.
 *
 * Cached on globalThis in development so that tsx's watch-mode reloads do not
 * open a new connection pool on every restart. SERVER-SIDE ONLY.
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
