import { randomInt } from "node:crypto";

import { prisma } from "../../lib/prisma.js";
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
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 3;
/** Requests a user can still act on — the states "not yet resolved". */
const ACTIVE_STATUSES = ["pending", "user_claimed_sent"];
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

/**
 * Throw when this Reddit username is already verified by a DIFFERENT app user.
 * A verified link is exclusive: two accounts can never claim one username.
 */
async function assertUsernameNotTaken(
  normalized: string,
  userId: string,
): Promise<void> {
  const takenByOther = await prisma.redditAccounts.findFirst({
    where: {
      redditUsernameNormalized: normalized,
      verificationStatus: "verified",
      userId: { not: userId },
    },
    select: { id: true },
  });
  if (takenByOther) {
    throw new Error("This Reddit username is already verified by another account.");
  }
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
  await assertUsernameNotTaken(normalized, userId);

  // Rate limit: at most MAX_REQUESTS_PER_HOUR in the trailing hour.
  const recent = await prisma.redditVerificationRequests.count({
    where: { userId, createdAt: { gt: new Date(Date.now() - ONE_HOUR_MS) } },
  });
  if (recent >= MAX_REQUESTS_PER_HOUR) {
    throw new Error(
      "Too many verification attempts. Please wait a while and try again.",
    );
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  // Retiring the old request and issuing the new one must happen together, or a
  // failure between them leaves the user with two live codes (or none).
  const inserted = await prisma.$transaction(async (tx) => {
    await tx.redditVerificationRequests.updateMany({
      where: { userId, status: { in: ACTIVE_STATUSES } },
      data: { status: "expired", updatedAt: new Date() },
    });

    return tx.redditVerificationRequests.create({
      data: {
        userId,
        redditUsername: redditUsername.trim(),
        redditUsernameNormalized: normalized,
        verificationCode: code,
        status: "pending",
        expiresAt,
      },
      select: { id: true },
    });
  });

  return {
    requestId: inserted.id,
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
  const { count } = await prisma.redditVerificationRequests.updateMany({
    where: {
      id: requestId,
      userId,
      status: { in: ACTIVE_STATUSES },
      expiresAt: { gt: new Date() },
    },
    data: { status: "user_claimed_sent", updatedAt: new Date() },
  });
  if (count === 0) {
    throw new Error("Verification request not found or expired.");
  }
}

/**
 * The user's best linked Reddit account: a verified link wins over a pending
 * one, then most recently updated. Two ordered lookups because Prisma cannot
 * sort on a computed boolean.
 */
async function findBestRedditAccount(userId: string) {
  const select = {
    redditUsername: true,
    verificationStatus: true,
    verificationMethod: true,
    verifiedAt: true,
  } as const;

  return (
    (await prisma.redditAccounts.findFirst({
      where: { userId, verificationStatus: "verified" },
      select,
      orderBy: { updatedAt: "desc" },
    })) ??
    (await prisma.redditAccounts.findFirst({
      where: { userId },
      select,
      orderBy: { updatedAt: "desc" },
    }))
  );
}

/** Current verification status for a user: latest request + linked account. */
export async function getRedditVerificationStatus(userId: string): Promise<{
  request: RedditVerificationRequest | null;
  account: RedditAccountSummary | null;
}> {
  const requestRow = await prisma.redditVerificationRequests.findFirst({
    where: { userId },
    select: {
      id: true,
      redditUsername: true,
      verificationCode: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const accountRow = await findBestRedditAccount(userId);

  return {
    request: requestRow
      ? {
          id: requestRow.id,
          redditUsername: requestRow.redditUsername,
          code: requestRow.verificationCode,
          status: requestRow.status,
          expiresAt: requestRow.expiresAt.toISOString(),
          createdAt: requestRow.createdAt.toISOString(),
        }
      : null,
    account: accountRow
      ? {
          redditUsername: accountRow.redditUsername,
          verificationStatus: accountRow.verificationStatus,
          verificationMethod: accountRow.verificationMethod,
          verifiedAt: accountRow.verifiedAt
            ? accountRow.verifiedAt.toISOString()
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
  const rows = await prisma.redditVerificationRequests.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
    select: {
      id: true,
      userId: true,
      redditUsername: true,
      verificationCode: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      // The JOIN on app_users, expressed as a relation.
      appUsers: { select: { email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((r) => ({
    requestId: r.id,
    userId: r.userId,
    email: r.appUsers.email,
    redditUsername: r.redditUsername,
    code: r.verificationCode,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
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
  const request = await prisma.redditVerificationRequests.findUnique({
    where: { id: requestId },
    select: {
      userId: true,
      redditUsername: true,
      redditUsernameNormalized: true,
    },
  });
  if (!request) {
    throw new Error("Verification request not found.");
  }

  await assertUsernameNotTaken(request.redditUsernameNormalized, request.userId);

  const now = new Date();

  // Approving the request and creating the verified link is one decision: never
  // leave a request marked verified without the account row that proves it.
  await prisma.$transaction([
    prisma.redditVerificationRequests.update({
      where: { id: requestId },
      data: {
        status: "verified",
        verifiedAt: now,
        adminNotes: adminNotes ?? null,
        updatedAt: now,
      },
    }),
    prisma.redditAccounts.upsert({
      where: { redditUsernameNormalized: request.redditUsernameNormalized },
      create: {
        userId: request.userId,
        redditUsername: request.redditUsername,
        redditUsernameNormalized: request.redditUsernameNormalized,
        verificationMethod: "inbound_dm_manual",
        verificationStatus: "verified",
        verifiedAt: now,
      },
      update: {
        userId: request.userId,
        redditUsername: request.redditUsername,
        verificationMethod: "inbound_dm_manual",
        verificationStatus: "verified",
        verifiedAt: now,
        updatedAt: now,
      },
    }),
  ]);
}

/** Admin: reject a request. */
export async function adminRejectRedditVerification(
  requestId: string,
  adminNotes?: string,
): Promise<void> {
  const now = new Date();
  const { count } = await prisma.redditVerificationRequests.updateMany({
    where: { id: requestId },
    data: {
      status: "rejected",
      rejectedAt: now,
      adminNotes: adminNotes ?? null,
      updatedAt: now,
    },
  });
  if (count === 0) {
    throw new Error("Verification request not found.");
  }
}

/** Let a user unlink their Reddit account and clear any active requests. */
export async function unlinkRedditAccount(userId: string): Promise<void> {
  const now = new Date();

  await prisma.$transaction([
    prisma.redditAccounts.deleteMany({ where: { userId } }),
    prisma.redditVerificationRequests.updateMany({
      where: { userId, status: { in: ACTIVE_STATUSES } },
      data: { status: "expired", updatedAt: now },
    }),
  ]);
}
