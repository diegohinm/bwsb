import { query } from "../lib/db.js";

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
async function step(label: string, sql: string): Promise<void> {
  try {
    const rows = await query<{ id: string }>(sql + " RETURNING id");
    console.log(`[tokens:expire] ${label}: ${rows.length}`);
  } catch (err) {
    console.error(
      `[tokens:expire] ${label} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function main(): Promise<void> {
  await step(
    "email verification tokens removed",
    `DELETE FROM public.email_verification_tokens
      WHERE expires_at < now() OR used_at IS NOT NULL`,
  );

  await step(
    "password reset tokens removed",
    `DELETE FROM public.password_reset_tokens
      WHERE expires_at < now() OR used_at IS NOT NULL`,
  );

  await step(
    "expired sessions removed",
    `DELETE FROM public.user_sessions
      WHERE expires_at < now()`,
  );

  await step(
    "reddit verification codes expired",
    `UPDATE public.reddit_verification_requests
        SET status = 'expired', updated_at = now()
      WHERE status IN ('pending', 'user_claimed_sent')
        AND expires_at < now()`,
  );

  console.log("[tokens:expire] done.");
}

void main();
