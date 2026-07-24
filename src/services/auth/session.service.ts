import { query, queryOne } from "../../lib/db.js";
import { createRandomToken, hashToken } from "./token.service.js";

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
  reddit: {
    username: string;
    verificationStatus: string;
  } | null;
}

interface AppUserRow {
  id: string;
  email: string;
  display_name: string | null;
  email_verified_at: Date | null;
}

interface RedditAccountRow {
  reddit_username: string;
  verification_status: string;
}

/**
 * Load an app_user by id and shape it as an AuthUser, including the best linked
 * Reddit account (a verified link wins over a pending one). Returns null when
 * the user does not exist.
 */
export async function getAuthUserById(userId: string): Promise<AuthUser | null> {
  const user = await queryOne<AppUserRow>(
    `SELECT id, email, display_name, email_verified_at
       FROM public.app_users
      WHERE id = $1`,
    [userId],
  );
  if (!user) return null;

  const reddit = await queryOne<RedditAccountRow>(
    `SELECT reddit_username, verification_status
       FROM public.reddit_accounts
      WHERE user_id = $1
      ORDER BY (verification_status = 'verified') DESC, updated_at DESC
      LIMIT 1`,
    [userId],
  );

  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    emailVerified: user.email_verified_at != null,
    reddit: reddit
      ? {
          username: reddit.reddit_username,
          verificationStatus: reddit.verification_status,
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

  await query(
    `INSERT INTO public.user_sessions (user_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );

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

  const session = await queryOne<{ user_id: string; expires_at: Date }>(
    `SELECT user_id, expires_at
       FROM public.user_sessions
      WHERE session_token_hash = $1`,
    [tokenHash],
  );

  if (!session) return null;

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await query(`DELETE FROM public.user_sessions WHERE session_token_hash = $1`, [
      tokenHash,
    ]);
    return null;
  }

  return getAuthUserById(session.user_id);
}

/** Destroy a session by its raw token (logout). Safe to call with any string. */
export async function clearSession(token: string): Promise<void> {
  if (!token) return;
  await query(`DELETE FROM public.user_sessions WHERE session_token_hash = $1`, [
    hashToken(token),
  ]);
}

export const SESSION_COOKIE_NAME = "yt_session";
export const SESSION_MAX_AGE_MS = THIRTY_DAYS_MS;
