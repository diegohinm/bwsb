import bcrypt from "bcryptjs";

/**
 * Password hashing + strength validation.
 *
 * Passwords are hashed with bcrypt (cost 12) and NEVER logged or stored in
 * plaintext. Only the resulting hash is persisted (app_users.password_hash).
 */

const BCRYPT_COST = 12;

/** Hash a plaintext password for storage. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Verify a plaintext password against a stored hash. */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

/**
 * Enforce the minimum password policy. Throws an Error with a user-safe message
 * when the password is too weak. The password itself is never included in the
 * thrown message.
 */
export function validatePasswordStrength(password: string): void {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters long");
  }
  if (!/[A-Za-z]/.test(password)) {
    throw new Error("Password must contain at least one letter");
  }
  if (!/[0-9]/.test(password)) {
    throw new Error("Password must contain at least one number");
  }
}
