import { query, queryOne } from "../../lib/db.js";
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
  const emailVerified = identity.emailVerified;

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM public.app_users WHERE email_normalized = $1`,
    [normalized],
  );

  if (existing) {
    await query(
      `UPDATE public.app_users
          SET google_sub = COALESCE(google_sub, $2),
              auth_provider = COALESCE(auth_provider, 'google'),
              email_verified_at = CASE
                WHEN $3::boolean AND email_verified_at IS NULL THEN now()
                ELSE email_verified_at
              END,
              avatar_url = CASE
                WHEN avatar_url IS NULL OR trim(avatar_url) = '' THEN $4
                ELSE avatar_url
              END,
              avatar_type = CASE
                WHEN avatar_url IS NULL OR trim(avatar_url) = '' THEN $5
                ELSE avatar_type
              END,
              updated_at = now(),
              last_login_at = now()
        WHERE id = $1`,
      [existing.id, identity.sub, emailVerified, DEFAULT_AVATAR_URL, DEFAULT_AVATAR_TYPE],
    );
    return { userId: existing.id };
  }

  // New account. email + email_normalized are both required and unique.
  const created = await queryOne<{ id: string }>(
    `INSERT INTO public.app_users
       (email, email_normalized, email_verified_at, display_name,
        google_sub, auth_provider, avatar_url, avatar_type, last_login_at)
     VALUES ($1, $2, $3, $4, $5, 'google', $6, $7, now())
     ON CONFLICT (email_normalized) DO UPDATE
       SET google_sub = COALESCE(public.app_users.google_sub, EXCLUDED.google_sub),
           last_login_at = now()
     RETURNING id`,
    [
      identity.email,
      normalized,
      emailVerified ? new Date() : null,
      identity.name ?? null,
      identity.sub,
      DEFAULT_AVATAR_URL,
      DEFAULT_AVATAR_TYPE,
    ],
  );

  if (!created) {
    throw new Error("Failed to create user from Google identity");
  }
  return { userId: created.id };
}
