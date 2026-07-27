import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../email/email.service.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./password.service.js";
import { createRandomToken, hashToken } from "./token.service.js";
import { createSession } from "./session.service.js";
import { DEFAULT_AVATAR_URL, DEFAULT_AVATAR_TYPE } from "../../config/branding.js";

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
  // New accounts get the global default frog avatar and the email auth_provider.
  // An empty `update` leaves an existing account completely untouched — signing
  // up again must never reset someone's avatar or provider.
  const user = await prisma.appUsers.upsert({
    where: { emailNormalized: normalized },
    create: {
      email: raw,
      emailNormalized: normalized,
      avatarUrl: DEFAULT_AVATAR_URL,
      avatarType: DEFAULT_AVATAR_TYPE,
      authProvider: "email",
    },
    update: {},
    select: { id: true },
  });

  const rawToken = createRandomToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  await prisma.emailVerificationTokens.create({
    data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt },
  });

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
  const row = await prisma.emailVerificationTokens.findFirst({
    where: {
      tokenHash: hashToken(token),
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { userId: true },
  });
  if (!row) {
    throw new Error("This link is invalid or has expired. Please request a new one.");
  }
  return { userId: row.userId };
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

  const row = await prisma.emailVerificationTokens.findFirst({
    where: {
      tokenHash: hashToken(token),
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, userId: true },
  });
  if (!row) {
    throw new Error("This link is invalid or has expired. Please request a new one.");
  }

  const passwordHash = await hashPassword(password);

  // Atomic: a password that is set without its token being burned would leave a
  // reusable link, and a burned token without a password would lock the user
  // out of an account they just proved they own.
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const current = await tx.appUsers.findUnique({
      where: { id: row.userId },
      select: { emailVerifiedAt: true },
    });

    await tx.appUsers.update({
      where: { id: row.userId },
      data: {
        passwordHash,
        // COALESCE: the FIRST verification timestamp is the one that counts.
        emailVerifiedAt: current?.emailVerifiedAt ?? now,
        updatedAt: now,
      },
    });

    // Burn this token and any other outstanding verification tokens for the user.
    await tx.emailVerificationTokens.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: now },
    });
  });

  return { userId: row.userId };
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

  const user = await prisma.appUsers.findUnique({
    where: { emailNormalized: normalized },
    select: { id: true, passwordHash: true },
  });

  if (!user || !user.passwordHash) {
    // Still run a comparison to reduce timing signal, then fail generically.
    await verifyPassword(password ?? "", "$2a$12$0000000000000000000000000000000000000000000000000000");
    throw genericError;
  }

  const ok = await verifyPassword(password ?? "", user.passwordHash);
  if (!ok) throw genericError;

  await prisma.appUsers.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return createSession(user.id);
}

/**
 * Step 1 of password reset. Emails a reset link when the account exists. Always
 * resolves regardless of existence (no enumeration).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalized = normalizeEmail(email ?? "");
  const user = await prisma.appUsers.findUnique({
    where: { emailNormalized: normalized },
    select: { id: true, email: true },
  });
  if (!user) return; // Silently succeed.

  const rawToken = createRandomToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await prisma.passwordResetTokens.create({
    data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt },
  });

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

  const row = await prisma.passwordResetTokens.findFirst({
    where: {
      tokenHash: hashToken(token),
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, userId: true },
  });
  if (!row) {
    throw new Error("This reset link is invalid or has expired. Please request a new one.");
  }

  const passwordHash = await hashPassword(newPassword);

  // Atomic: the new password, the burnt token and the session revocation must
  // land together, or a half-applied reset leaves old sessions alive.
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const current = await tx.appUsers.findUnique({
      where: { id: row.userId },
      select: { emailVerifiedAt: true },
    });

    await tx.appUsers.update({
      where: { id: row.userId },
      data: {
        passwordHash,
        emailVerifiedAt: current?.emailVerifiedAt ?? now,
        updatedAt: now,
      },
    });

    await tx.passwordResetTokens.update({
      where: { id: row.id },
      data: { usedAt: now },
    });

    // Revoke all active sessions after a password change.
    await tx.userSessions.deleteMany({ where: { userId: row.userId } });
  });
}
