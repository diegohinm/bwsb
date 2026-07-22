import { randomInt } from "node:crypto";
import { query, queryOne } from "../../lib/db.js";
import { env } from "../../config/env.js";

/**
 * Optional Reddit username verification (INBOUND ONLY).
 *
 * The user proves control of a Reddit account by voluntarily sending a
 * generated code as a Reddit message to u/<REDDIT_VERIFICATION_USERNAME>. The
 * app NEVER sends outbound DMs. For now an admin reviews that inbox and approves
 * or rejects the request manually.
 *
 * This is purely for a profile badge / rankings / credibility — it is never
 * required to sign up, log in, or use the app.
 */

const CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REQUESTS_PER_HOUR = 3;
// Unambiguous uppercase alphabet (no O/0/I/1) for the human-typed code.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface RedditVerificationRequest {
  id: string;
  redditUsername: string;
  code: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface RedditAccountSummary {
  redditUsername: string;
  verificationStatus: string;
  verificationMethod: string;
  verifiedAt: string | null;
}

/** Normalize a Reddit username: trim, strip leading u/ or /u/, lowercase. */
export function normalizeRedditUsername(username: string): string {
  return (username ?? "")
    .trim()
    .replace(/^\/?u\//i, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

/** Reddit usernames: 3–20 chars of letters, digits, underscore or hyphen. */
function isValidRedditUsername(normalized: string): boolean {
  return /^[a-z0-9_-]{3,20}$/.test(normalized);
}

function generateCode(): string {
  let body = "";
  for (let i = 0; i < 6; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `YOLO-${body}`;
}

function buildInstructions(): string {
  return (
    `Send this exact code as a Reddit message to u/${env.REDDIT_VERIFICATION_USERNAME} ` +
    `from the Reddit account you want to verify. After sending it, click ` +
    `"I sent the message".`
  );
}

interface RequestRow {
  id: string;
  reddit_username: string;
  verification_code: string;
  status: string;
  expires_at: Date;
  created_at: Date;
}

function toRequest(row: RequestRow): RedditVerificationRequest {
  return {
    id: row.id,
    redditUsername: row.reddit_username,
    code: row.verification_code,
    status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Start (or restart) a verification request for the given user + Reddit
 * username. Enforces: valid username, not already verified by another user,
 * max 3 requests/hour, and a single active request per user.
 */
export async function startRedditVerification(
  userId: string,
  redditUsername: string,
): Promise<{
  requestId: string;
  code: string;
  expiresAt: string;
  instructions: string;
}> {
  const normalized = normalizeRedditUsername(redditUsername);
  if (!isValidRedditUsername(normalized)) {
    throw new Error("Please enter a valid Reddit username.");
  }

  // A username already verified by a different account cannot be re-claimed.
  const takenByOther = await queryOne<{ id: string }>(
    `SELECT id FROM public.reddit_accounts
      WHERE reddit_username_normalized = $1
        AND verification_status = 'verified'
        AND user_id <> $2`,
    [normalized, userId],
  );
  if (takenByOther) {
    throw new Error("This Reddit username is already verified by another account.");
  }

  // Rate limit: at most MAX_REQUESTS_PER_HOUR in the trailing hour.
  const recent = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM public.reddit_verification_requests
      WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [userId],
  );
  if (recent && Number(recent.count) >= MAX_REQUESTS_PER_HOUR) {
    throw new Error(
      "Too many verification attempts. Please wait a while and try again.",
    );
  }

  // Retire any still-active request so there is only one live request per user.
  await query(
    `UPDATE public.reddit_verification_requests
        SET status = 'expired', updated_at = now()
      WHERE user_id = $1 AND status IN ('pending', 'user_claimed_sent')`,
    [userId],
  );

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO public.reddit_verification_requests
       (user_id, reddit_username, reddit_username_normalized, verification_code, status, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     RETURNING id`,
    [userId, redditUsername.trim(), normalized, code, expiresAt],
  );

  return {
    requestId: inserted!.id,
    code,
    expiresAt: expiresAt.toISOString(),
    instructions: buildInstructions(),
  };
}

/**
 * The user claims they have sent the message. Flips a pending request to
 * `user_claimed_sent` so an admin knows to look for it.
 */
export async function markRedditVerificationSent(
  userId: string,
  requestId: string,
): Promise<void> {
  const rows = await query(
    `UPDATE public.reddit_verification_requests
        SET status = 'user_claimed_sent', updated_at = now()
      WHERE id = $1 AND user_id = $2
        AND status IN ('pending', 'user_claimed_sent')
        AND expires_at > now()
      RETURNING id`,
    [requestId, userId],
  );
  if (rows.length === 0) {
    throw new Error("Verification request not found or expired.");
  }
}

/** Current verification status for a user: latest request + linked account. */
export async function getRedditVerificationStatus(userId: string): Promise<{
  request: RedditVerificationRequest | null;
  account: RedditAccountSummary | null;
}> {
  const requestRow = await queryOne<RequestRow>(
    `SELECT id, reddit_username, verification_code, status, expires_at, created_at
       FROM public.reddit_verification_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );

  const accountRow = await queryOne<{
    reddit_username: string;
    verification_status: string;
    verification_method: string;
    verified_at: Date | null;
  }>(
    `SELECT reddit_username, verification_status, verification_method, verified_at
       FROM public.reddit_accounts
      WHERE user_id = $1
      ORDER BY (verification_status = 'verified') DESC, updated_at DESC
      LIMIT 1`,
    [userId],
  );

  return {
    request: requestRow ? toRequest(requestRow) : null,
    account: accountRow
      ? {
          redditUsername: accountRow.reddit_username,
          verificationStatus: accountRow.verification_status,
          verificationMethod: accountRow.verification_method,
          verifiedAt: accountRow.verified_at
            ? new Date(accountRow.verified_at).toISOString()
            : null,
        }
      : null,
  };
}

/** Admin: list requests awaiting review (with the requester's email). */
export async function getPendingRedditVerifications(): Promise<
  Array<{
    requestId: string;
    userId: string;
    email: string;
    redditUsername: string;
    code: string;
    status: string;
    expiresAt: string;
    createdAt: string;
  }>
> {
  const rows = await query<{
    id: string;
    user_id: string;
    email: string;
    reddit_username: string;
    verification_code: string;
    status: string;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT r.id, r.user_id, u.email, r.reddit_username, r.verification_code,
            r.status, r.expires_at, r.created_at
       FROM public.reddit_verification_requests r
       JOIN public.app_users u ON u.id = r.user_id
      WHERE r.status IN ('pending', 'user_claimed_sent')
      ORDER BY r.created_at ASC`,
  );

  return rows.map((r) => ({
    requestId: r.id,
    userId: r.user_id,
    email: r.email,
    redditUsername: r.reddit_username,
    code: r.verification_code,
    status: r.status,
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Admin: approve a request. Marks it verified and upserts a verified
 * reddit_accounts row. Fails if the username is verified by another user.
 */
export async function adminApproveRedditVerification(
  requestId: string,
  adminNotes?: string,
): Promise<void> {
  const request = await queryOne<{
    user_id: string;
    reddit_username: string;
    reddit_username_normalized: string;
  }>(
    `SELECT user_id, reddit_username, reddit_username_normalized
       FROM public.reddit_verification_requests
      WHERE id = $1`,
    [requestId],
  );
  if (!request) {
    throw new Error("Verification request not found.");
  }

  const takenByOther = await queryOne<{ id: string }>(
    `SELECT id FROM public.reddit_accounts
      WHERE reddit_username_normalized = $1
        AND verification_status = 'verified'
        AND user_id <> $2`,
    [request.reddit_username_normalized, request.user_id],
  );
  if (takenByOther) {
    throw new Error("This Reddit username is already verified by another account.");
  }

  await query(
    `UPDATE public.reddit_verification_requests
        SET status = 'verified', verified_at = now(), admin_notes = $2, updated_at = now()
      WHERE id = $1`,
    [requestId, adminNotes ?? null],
  );

  await query(
    `INSERT INTO public.reddit_accounts
       (user_id, reddit_username, reddit_username_normalized, verification_method, verification_status, verified_at)
     VALUES ($1, $2, $3, 'inbound_dm_manual', 'verified', now())
     ON CONFLICT (reddit_username_normalized)
     DO UPDATE SET user_id = EXCLUDED.user_id,
                   reddit_username = EXCLUDED.reddit_username,
                   verification_method = 'inbound_dm_manual',
                   verification_status = 'verified',
                   verified_at = now(),
                   updated_at = now()`,
    [request.user_id, request.reddit_username, request.reddit_username_normalized],
  );
}

/** Admin: reject a request. */
export async function adminRejectRedditVerification(
  requestId: string,
  adminNotes?: string,
): Promise<void> {
  const rows = await query(
    `UPDATE public.reddit_verification_requests
        SET status = 'rejected', rejected_at = now(), admin_notes = $2, updated_at = now()
      WHERE id = $1
      RETURNING id`,
    [requestId, adminNotes ?? null],
  );
  if (rows.length === 0) {
    throw new Error("Verification request not found.");
  }
}

/** Let a user unlink their Reddit account and clear any active requests. */
export async function unlinkRedditAccount(userId: string): Promise<void> {
  await query(`DELETE FROM public.reddit_accounts WHERE user_id = $1`, [userId]);
  await query(
    `UPDATE public.reddit_verification_requests
        SET status = 'expired', updated_at = now()
      WHERE user_id = $1 AND status IN ('pending', 'user_claimed_sent')`,
    [userId],
  );
}
