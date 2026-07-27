import { prisma, disconnectPrisma } from "../lib/prisma.js";

/**
 * Expire and clean up stale auth artefacts. Manual/dev:
 *   npm run tokens:expire
 *
 * Covers everything the rules call out under "expirar códigos/tokens" and
 * "expirar sessions":
 *   - email verification tokens (expired or already used)
 *   - password reset tokens (expired or already used)
 *   - user sessions past their expiry
 *   - inbound Reddit verification codes past their expiry (marked 'expired')
 *
 * Idempotent (a second run finds nothing left to do), fault-tolerant (each step
 * is isolated so one failing table doesn't abort the rest) and leaves verifiable
 * evidence: the deleted rows are gone and expired Reddit requests flip to
 * status='expired'. Per-step counts are logged.
 */

/** Run one cleanup step, logging its row count and never throwing. */
async function step(
  label: string,
  run: () => Promise<{ count: number }>,
): Promise<void> {
  try {
    const { count } = await run();
    console.log(`[tokens:expire] ${label}: ${count}`);
  } catch (err) {
    console.error(
      `[tokens:expire] ${label} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function main(): Promise<void> {
  const now = new Date();

  await step("email verification tokens removed", () =>
    prisma.emailVerificationTokens.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    }),
  );

  await step("password reset tokens removed", () =>
    prisma.passwordResetTokens.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    }),
  );

  await step("expired sessions removed", () =>
    prisma.userSessions.deleteMany({ where: { expiresAt: { lt: now } } }),
  );

  await step("reddit verification codes expired", () =>
    prisma.redditVerificationRequests.updateMany({
      where: {
        status: { in: ["pending", "user_claimed_sent"] },
        expiresAt: { lt: now },
      },
      data: { status: "expired", updatedAt: now },
    }),
  );

  console.log("[tokens:expire] done.");
}

void main().finally(disconnectPrisma);
