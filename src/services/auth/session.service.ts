import { prisma } from "../../lib/prisma.js";
import { createRandomToken, hashToken } from "./token.service.js";
import { DEFAULT_AVATAR_URL } from "../../config/branding.js";

/**
 * Session lifecycle for email-auth users.
 *
 * A session is an opaque random token delivered to the browser in the httpOnly
 * `yt_session` cookie. Only the sha256 hash of the token is stored in
 * `user_sessions`; the raw token never touches the database or the logs.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** The signed-in user shape attached to req.user and returned by /auth/me. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  /** Resolved avatar URL — the user's own, or the global default frog. */
  avatarUrl: string;
  reddit: {
    username: string;
    verificationStatus: string;
  } | null;
}

/**
 * Load an app_user by id and shape it as an AuthUser, including the best linked
 * Reddit account (a verified link wins over a pending one). Returns null when
 * the user does not exist.
 */
export async function getAuthUserById(userId: string): Promise<AuthUser | null> {
  const user = await prisma.appUsers.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      emailVerifiedAt: true,
      avatarUrl: true,
    },
  });
  if (!user) return null;

  // "Verified wins, then most recently updated". Expressed as two ordered
  // lookups because Prisma cannot sort on a computed boolean.
  const reddit =
    (await prisma.redditAccounts.findFirst({
      where: { userId, verificationStatus: "verified" },
      select: { redditUsername: true, verificationStatus: true },
      orderBy: { updatedAt: "desc" },
    })) ??
    (await prisma.redditAccounts.findFirst({
      where: { userId },
      select: { redditUsername: true, verificationStatus: true },
      orderBy: { updatedAt: "desc" },
    }));

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt != null,
    // Whitespace-only avatar_url counts as "no avatar" — same rule as the
    // frontend helper (fwsb/src/lib/avatar.ts) so both sides agree.
    avatarUrl:
      user.avatarUrl && user.avatarUrl.trim().length > 0
        ? user.avatarUrl
        : DEFAULT_AVATAR_URL,
    reddit: reddit
      ? {
          username: reddit.redditUsername,
          verificationStatus: reddit.verificationStatus,
        }
      : null,
  };
}

/**
 * Create a new session for a user and return the RAW token (store it in the
 * httpOnly cookie). Expires 30 days out.
 */
export async function createSession(userId: string): Promise<string> {
  const rawToken = createRandomToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);

  await prisma.userSessions.create({
    data: { userId, sessionTokenHash: tokenHash, expiresAt },
  });

  return rawToken;
}

/**
 * Validate a raw session token from the cookie. Returns the AuthUser when the
 * session exists and is not expired, otherwise null. Expired sessions are
 * cleaned up opportunistically.
 */
export async function verifySessionToken(
  token: string,
): Promise<AuthUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const session = await prisma.userSessions.findUnique({
    where: { sessionTokenHash: tokenHash },
    select: { userId: true, expiresAt: true },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    // deleteMany, not delete: a concurrent request may have removed it already,
    // and a missing row is not an error here.
    await prisma.userSessions.deleteMany({
      where: { sessionTokenHash: tokenHash },
    });
    return null;
  }

  return getAuthUserById(session.userId);
}

/** Destroy a session by its raw token (logout). Safe to call with any string. */
export async function clearSession(token: string): Promise<void> {
  if (!token) return;
  await prisma.userSessions.deleteMany({
    where: { sessionTokenHash: hashToken(token) },
  });
}

export const SESSION_COOKIE_NAME = "yt_session";
export const SESSION_MAX_AGE_MS = THIRTY_DAYS_MS;
