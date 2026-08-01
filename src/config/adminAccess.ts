import { env, isProduction } from "./env.js";

/**
 * Who counts as an administrator.
 *
 * This project has NO role column on `app_users` — accounts are email-identified
 * and otherwise equal. Administration is therefore expressed two ways, and this
 * module is the single place that decides:
 *
 *   ADMIN_SECRET  a shared secret sent as `x-admin-secret`. Server-to-server
 *                 and curl only — never put it in a browser.
 *   ADMIN_EMAILS  a comma-separated allowlist. A SIGNED-IN user whose email is
 *                 on it is an admin, which is what lets internal PAGES work in
 *                 production without shipping a secret to the client.
 *
 * With ADMIN_EMAILS unset nobody is an admin and internal pages are
 * development-only. That is the safe default: forgetting to configure this
 * closes the door rather than opening it.
 */

/** Normalized allowlist, parsed once. */
const ADMIN_EMAIL_SET: ReadonlySet<string> = new Set(
  (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
);

/** True when at least one admin email is configured. */
export const hasAdminEmails: boolean = ADMIN_EMAIL_SET.size > 0;

/** Whether this email address is an administrator. Case-insensitive. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAIL_SET.has(email.trim().toLowerCase());
}

/**
 * Whether internal/diagnostic surfaces are open purely because this is a
 * development environment.
 *
 * Deliberately keyed off `isProduction` rather than `NODE_ENV === "development"`
 * so that `test` also counts as non-production — otherwise every internal-route
 * test would need a fake admin session.
 */
export const internalAccessOpenByEnvironment: boolean = !isProduction;
