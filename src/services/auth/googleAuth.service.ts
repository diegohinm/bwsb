import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { DEFAULT_AVATAR_URL, DEFAULT_AVATAR_TYPE } from "../../config/branding.js";
import { normalizeEmail } from "./emailAuth.service.js";
import type { GoogleIdentity } from "./google.js";

/**
 * Google OAuth account linking.
 *
 * Identity is unified on EMAIL. A Google login either:
 *   - links to an existing app_user with the same (normalized) email, or
 *   - creates a brand-new app_user.
 * We never create a duplicate account for an email that already exists, and we
 * never touch the email/password login path — a user can keep signing in with
 * their password after linking Google.
 *
 * The resulting session is a normal yt_session (see session.service). Google
 * users have no password_hash; they authenticate through Google every time.
 */

/** An avatar_url that is null, empty or whitespace-only counts as "no avatar". */
function hasAvatar(avatarUrl: string | null): boolean {
  return avatarUrl !== null && avatarUrl.trim().length > 0;
}

/**
 * Link a Google identity onto an app_user that already exists for this email.
 *
 * Mirrors the COALESCE/CASE rules the previous SQL used: nothing already set is
 * ever overwritten — an existing google_sub, auth_provider, verification
 * timestamp or personalized avatar all survive.
 */
async function linkGoogleToExistingUser(
  userId: string,
  identity: GoogleIdentity,
): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const current = await tx.appUsers.findUniqueOrThrow({
      where: { id: userId },
      select: {
        googleSub: true,
        authProvider: true,
        emailVerifiedAt: true,
        avatarUrl: true,
        avatarType: true,
      },
    });

    const keepAvatar = hasAvatar(current.avatarUrl);

    await tx.appUsers.update({
      where: { id: userId },
      data: {
        googleSub: current.googleSub ?? identity.sub,
        authProvider: current.authProvider ?? "google",
        emailVerifiedAt:
          identity.emailVerified && current.emailVerifiedAt === null
            ? now
            : current.emailVerifiedAt,
        avatarUrl: keepAvatar ? current.avatarUrl : DEFAULT_AVATAR_URL,
        avatarType: keepAvatar ? current.avatarType : DEFAULT_AVATAR_TYPE,
        updatedAt: now,
        lastLoginAt: now,
      },
    });
  });
}

/**
 * Find or create the app_user for a Google identity and return its id.
 *
 * Rules:
 *  - Match on email_normalized. If a user exists, link google_sub to it and mark
 *    the email verified when Google reports it verified. An existing personalized
 *    avatar is preserved; only a null/empty avatar is backfilled to the default.
 *  - Otherwise insert a new user with auth_provider='google', the default frog
 *    avatar, and email_verified_at set when Google reports the email verified.
 */
export async function findOrCreateUserFromGoogle(
  identity: GoogleIdentity,
): Promise<{ userId: string }> {
  const normalized = normalizeEmail(identity.email);

  const existing = await prisma.appUsers.findUnique({
    where: { emailNormalized: normalized },
    select: { id: true },
  });

  if (existing) {
    await linkGoogleToExistingUser(existing.id, identity);
    return { userId: existing.id };
  }

  // New account. email + email_normalized are both required and unique.
  try {
    const created = await prisma.appUsers.create({
      data: {
        email: identity.email,
        emailNormalized: normalized,
        emailVerifiedAt: identity.emailVerified ? new Date() : null,
        displayName: identity.name ?? null,
        googleSub: identity.sub,
        authProvider: "google",
        avatarUrl: DEFAULT_AVATAR_URL,
        avatarType: DEFAULT_AVATAR_TYPE,
        lastLoginAt: new Date(),
      },
      select: { id: true },
    });
    return { userId: created.id };
  } catch (err) {
    // A concurrent login for the same email won the race between the lookup
    // above and this insert. Fall back to linking, exactly as the previous
    // ON CONFLICT (email_normalized) DO UPDATE did.
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== "P2002"
    ) {
      throw err;
    }

    const raced = await prisma.appUsers.findUnique({
      where: { emailNormalized: normalized },
      select: { id: true },
    });
    if (!raced) throw new Error("Failed to create user from Google identity");

    await linkGoogleToExistingUser(raced.id, identity);
    return { userId: raced.id };
  }
}
