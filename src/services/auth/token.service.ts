import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque token helpers for sessions, email verification and password resets.
 *
 * The RAW token is what we hand to the user (cookie / email link). We only ever
 * store its sha256 hash, so a database leak does not expose usable tokens. Raw
 * tokens are never logged.
 */

/** Generate a cryptographically-random, URL-safe token. */
export function createRandomToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hash a raw token (sha256) for storage / lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
