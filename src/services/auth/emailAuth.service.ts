import { query, queryOne } from "../../lib/db.js";
import { env } from "../../config/env.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../email/email.service.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./password.service.js";
import { createRandomToken, hashToken } from "./token.service.js";
import { createSession } from "./session.service.js";

/**
 * Email + password authentication — the PRIMARY auth system.
 *
 * Signup is passwordless-link first: the user submits an email, receives a
 * one-time link, and sets their password on that page (which also verifies the
 * email). This avoids ever collecting a password before proving email control.
 *
 * Enumeration safety: signup and password-reset requests ALWAYS resolve the
 * same way regardless of whether the email already exists.
 */

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Normalize an email for storage/lookup: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Step 1 of signup. Create the account if new, then email a set-password link.
 * Always resolves so callers cannot probe which emails exist.
 */
export async function requestEmailSignup(email: string): Promise<void> {
  const raw = (email ?? "").trim();
  if (!EMAIL_RE.test(raw)) {
    // Invalid format is a client error we can surface without leaking anything.
    throw new Error("Please enter a valid email address");
  }
  const normalized = normalizeEmail(raw);

  // Create the user if they don't exist yet (idempotent on email_normalized).
  await query(
    `INSERT INTO public.app_users (email, email_normalized)
     VALUES ($1, $2)
     ON CONFLICT (email_normalized) DO NOTHING`,
    [raw, normalized],
  );

  const user = await queryOne<{ id: string }>(
    `SELECT id FROM public.app_users WHERE email_normalized = $1`,
    [normalized],
  );
  // Should always exist after the upsert, but stay defensive.
  if (!user) return;

  const rawToken = createRandomToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  await query(
    `INSERT INTO public.email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hashToken(rawToken), expiresAt],
  );

  const url = `${env.FRONTEND_ORIGIN}/set-password?token=${rawToken}`;
  await sendVerificationEmail(raw, url);
}

/**
 * Validate an email-verification token without consuming it. Throws when the
 * token is unknown, already used or expired.
 */
export async function verifyEmailToken(
  token: string,
): Promise<{ userId: string }> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id
       FROM public.email_verification_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) {
    throw new Error("This link is invalid or has expired. Please request a new one.");
  }
  return { userId: row.user_id };
}

/**
 * Consume an email-verification token: mark the email verified, set the
 * password, and burn the token. Returns the user id so the caller can start a
 * session. Throws on weak passwords or invalid/expired tokens.
 */
export async function setPasswordAfterVerification(
  token: string,
  password: string,
): Promise<{ userId: string }> {
  validatePasswordStrength(password);

  const tokenHash = hashToken(token);
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM public.email_verification_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  if (!row) {
    throw new Error("This link is invalid or has expired. Please request a new one.");
  }

  const passwordHash = await hashPassword(password);

  await query(
    `UPDATE public.app_users
        SET password_hash = $1,
            email_verified_at = COALESCE(email_verified_at, now()),
            updated_at = now()
      WHERE id = $2`,
    [passwordHash, row.user_id],
  );

  // Burn this token and any other outstanding verification tokens for the user.
  await query(
    `UPDATE public.email_verification_tokens
        SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL`,
    [row.user_id],
  );

  return { userId: row.user_id };
}

/**
 * Email + password login. Returns a raw session token on success. Throws a
 * generic error on any failure so we never reveal whether the email exists.
 */
export async function loginWithEmail(
  email: string,
  password: string,
): Promise<string> {
  const normalized = normalizeEmail(email ?? "");
  const genericError = new Error("Invalid email or password");

  const user = await queryOne<{ id: string; password_hash: string | null }>(
    `SELECT id, password_hash FROM public.app_users WHERE email_normalized = $1`,
    [normalized],
  );

  if (!user || !user.password_hash) {
    // Still run a comparison to reduce timing signal, then fail generically.
    await verifyPassword(password ?? "", "$2a$12$0000000000000000000000000000000000000000000000000000");
    throw genericError;
  }

  const ok = await verifyPassword(password ?? "", user.password_hash);
  if (!ok) throw genericError;

  await query(`UPDATE public.app_users SET last_login_at = now() WHERE id = $1`, [
    user.id,
  ]);

  return createSession(user.id);
}

/**
 * Step 1 of password reset. Emails a reset link when the account exists. Always
 * resolves regardless of existence (no enumeration).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalized = normalizeEmail(email ?? "");
  const user = await queryOne<{ id: string; email: string }>(
    `SELECT id, email FROM public.app_users WHERE email_normalized = $1`,
    [normalized],
  );
  if (!user) return; // Silently succeed.

  const rawToken = createRandomToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await query(
    `INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hashToken(rawToken), expiresAt],
  );

  const url = `${env.FRONTEND_ORIGIN}/reset-password?token=${rawToken}`;
  await sendPasswordResetEmail(user.email, url);
}

/**
 * Step 2 of password reset. Sets a new password, burns the token, and revokes
 * all existing sessions for the user. Throws on weak passwords or bad tokens.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  validatePasswordStrength(newPassword);

  const tokenHash = hashToken(token);
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM public.password_reset_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  if (!row) {
    throw new Error("This reset link is invalid or has expired. Please request a new one.");
  }

  const passwordHash = await hashPassword(newPassword);

  await query(
    `UPDATE public.app_users
        SET password_hash = $1,
            email_verified_at = COALESCE(email_verified_at, now()),
            updated_at = now()
      WHERE id = $2`,
    [passwordHash, row.user_id],
  );

  await query(
    `UPDATE public.password_reset_tokens SET used_at = now() WHERE id = $1`,
    [row.id],
  );

  // Revoke all active sessions after a password change.
  await query(`DELETE FROM public.user_sessions WHERE user_id = $1`, [row.user_id]);
}
