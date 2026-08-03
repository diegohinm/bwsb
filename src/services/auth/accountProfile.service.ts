import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { sendVerificationEmail } from "../email/email.service.js";
import { EmailDeliveryError } from "../email/EmailDeliveryError.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./password.service.js";
import { createRandomToken, hashToken } from "./token.service.js";
import {
  isValidEmail,
  normalizeEmail,
  issueTokenThenSend,
  TOKEN_PURPOSE,
  TOKEN_STATUS,
} from "./emailAuth.service.js";

/**
 * Authenticated self-service account changes.
 *
 * Every function takes the user id the SESSION resolved to. None of them accept
 * one from the client, so there is no shape of request that edits somebody
 * else's account.
 */

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 40;
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountValidationError";
  }
}

export class EmailInUseError extends Error {
  constructor() {
    super("That email address is already in use.");
    this.name = "EmailInUseError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor(message = "Your current password is incorrect.") {
    super(message);
    this.name = "InvalidCredentialsError";
  }
}

export type ProfileUpdate = {
  displayName?: unknown;
  email?: unknown;
};

export type ProfileUpdateResult = {
  displayName: string | null;
  email: string;
  emailVerified: boolean;
  /** True when this call changed the address and reset its verified state. */
  emailChanged: boolean;
  /** True when a fresh verification link was accepted by the mail server. */
  verificationEmailSent: boolean;
};

function cleanDisplayName(raw: unknown): string | null {
  if (raw === undefined) return undefined as unknown as string | null;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new AccountValidationError("Display name must be text.");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new AccountValidationError("Display name cannot be empty.");
  }
  if (trimmed.length < DISPLAY_NAME_MIN) {
    throw new AccountValidationError(
      `Display name must be at least ${DISPLAY_NAME_MIN} characters.`,
    );
  }
  if (trimmed.length > DISPLAY_NAME_MAX) {
    throw new AccountValidationError(
      `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`,
    );
  }
  return trimmed;
}

/**
 * Update the caller's display name and/or email address.
 *
 * CHANGING THE EMAIL RESETS ITS VERIFIED STATE. It has to: the account has not
 * proved control of the new address, and carrying the old verification across
 * would let anyone with a session mark an arbitrary address as verified.
 *
 * A verification link is then sent. If the mail server refuses it the change is
 * still saved — the address is simply pending, and the user can ask for another
 * link. Rolling back a legitimate edit because SMTP is down would be worse.
 */
export async function updateProfile(
  userId: string,
  patch: ProfileUpdate,
): Promise<ProfileUpdateResult> {
  const current = await prisma.appUsers.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailNormalized: true, displayName: true, emailVerifiedAt: true },
  });
  if (!current) throw new AccountValidationError("Account not found.");

  const data: { displayName?: string | null; email?: string; emailNormalized?: string; emailVerifiedAt?: Date | null; updatedAt: Date } =
    { updatedAt: new Date() };

  if (patch.displayName !== undefined) {
    data.displayName = cleanDisplayName(patch.displayName);
  }

  let emailChanged = false;
  let nextEmail = current.email;

  if (patch.email !== undefined) {
    if (typeof patch.email !== "string" || !isValidEmail(patch.email)) {
      throw new AccountValidationError("Please enter a valid email address.");
    }
    const raw = patch.email.trim();
    const normalized = normalizeEmail(raw);

    if (normalized !== current.emailNormalized) {
      // Case-insensitive uniqueness, checked against the normalized column so
      // "A@x.com" cannot coexist with "a@x.com".
      const taken = await prisma.appUsers.findUnique({
        where: { emailNormalized: normalized },
        select: { id: true },
      });
      if (taken && taken.id !== userId) throw new EmailInUseError();

      data.email = raw;
      data.emailNormalized = normalized;
      data.emailVerifiedAt = null;
      emailChanged = true;
      nextEmail = raw;
    }
  }

  const updated = await prisma.appUsers.update({
    where: { id: userId },
    data,
    select: { displayName: true, email: true, emailVerifiedAt: true },
  });

  let verificationEmailSent = false;
  if (emailChanged) {
    // Any outstanding link points at the OLD address; it must not stay usable.
    await prisma.emailVerificationTokens.updateMany({
      where: { userId, usedAt: null, status: { in: [TOKEN_STATUS.pending, TOKEN_STATUS.sent] } },
      data: { status: TOKEN_STATUS.failed },
    });

    const rawToken = createRandomToken();
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
    const url = `${env.FRONTEND_ORIGIN}/set-password?token=${rawToken}`;

    try {
      await issueTokenThenSend({
        createToken: () =>
          prisma.emailVerificationTokens.create({
            data: {
              userId,
              tokenHash: hashToken(rawToken),
              status: TOKEN_STATUS.pending,
              purpose: TOKEN_PURPOSE.emailRegistration,
              expiresAt,
            },
            select: { id: true },
          }),
        send: () => sendVerificationEmail(nextEmail, url),
        markSent: async (id) => {
          await prisma.emailVerificationTokens.update({
            where: { id },
            data: { status: TOKEN_STATUS.sent, sentAt: new Date() },
          });
        },
        discard: async (id) => {
          await prisma.emailVerificationTokens.delete({ where: { id } });
        },
      });
      verificationEmailSent = true;
    } catch (err) {
      // Logged, not fatal. The address is saved and pending; the caller reports
      // that the link could not be sent rather than pretending it was.
      if (!(err instanceof EmailDeliveryError)) throw err;
      console.error("[account] verification email for a changed address failed to send");
    }
  }

  return {
    displayName: updated.displayName,
    email: updated.email,
    emailVerified: updated.emailVerifiedAt != null,
    emailChanged,
    verificationEmailSent,
  };
}

export type ChangePasswordResult = {
  /** How many other sessions were revoked by the change. */
  revokedSessions: number;
};

/**
 * Change the caller's password.
 *
 * Requires the CURRENT password even though the caller already holds a session:
 * a borrowed or hijacked session must not be enough to lock the real owner out
 * of their own account.
 *
 * On success every OTHER session is revoked and outstanding reset links are
 * burned, so a change made because "someone else might be in my account" is
 * actually effective. The calling session survives on purpose — signing the
 * user out of the tab where they just changed it reads as a failure.
 */
export async function changePassword(
  userId: string,
  currentPassword: unknown,
  newPassword: unknown,
  keepSessionToken?: string,
): Promise<ChangePasswordResult> {
  if (typeof newPassword !== "string") {
    throw new AccountValidationError("A new password is required.");
  }

  const user = await prisma.appUsers.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw new AccountValidationError("Account not found.");

  if (!user.passwordHash) {
    // OAuth-only account: there is no current password to check, and asking for
    // one would be asking for something that does not exist.
    throw new AccountValidationError(
      "This account signs in with a provider and has no password yet. Use “Forgot password” to set one.",
    );
  }

  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    throw new InvalidCredentialsError();
  }
  const matches = await verifyPassword(currentPassword, user.passwordHash);
  if (!matches) throw new InvalidCredentialsError();

  // Same policy as registration, enforced server-side.
  validatePasswordStrength(newPassword);

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  const revokedSessions = await prisma.$transaction(async (tx) => {
    await tx.appUsers.update({
      where: { id: userId },
      data: { passwordHash, updatedAt: now },
    });

    // A live reset link would undo the change the user just made.
    await tx.passwordResetTokens.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });

    const revoked = await tx.userSessions.deleteMany({
      where: {
        userId,
        ...(keepSessionToken
          ? { sessionTokenHash: { not: hashToken(keepSessionToken) } }
          : {}),
      },
    });
    return revoked.count;
  });

  return { revokedSessions };
}

/** True when the account has a local password (i.e. is not OAuth-only). */
export async function hasLocalPassword(userId: string): Promise<boolean> {
  const user = await prisma.appUsers.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return Boolean(user?.passwordHash);
}
