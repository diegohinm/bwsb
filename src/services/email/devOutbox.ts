import { isProduction, env } from "../../config/env.js";

/**
 * In-memory development outbox for transactional emails.
 *
 * When email runs in console mode (DEV_EMAIL_MODE=true or SMTP not configured)
 * the verification / password-reset links are only printed to the backend
 * console. That makes end-to-end QA of the auth flow impossible when the console
 * is not attached to the reviewer's tooling. This outbox additionally keeps the
 * last N dev emails (with the extracted link) in memory so a protected,
 * dev-only endpoint can hand the link back — no real inbox required.
 *
 * SAFETY: this is only ever populated/served in NON-production console mode
 * (see `isDevOutboxEnabled`). It never runs when real SMTP is sending mail in
 * production, so genuine one-time links are never exposed over HTTP.
 */

export interface DevOutboxEntry {
  id: number;
  to: string;
  subject: string;
  /** The first URL found in the email body (verification / reset link). */
  link: string | null;
  text: string;
  createdAt: string;
}

/** Console mode is active only when we are NOT sending real SMTP email. */
function smtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT);
}

/**
 * The dev outbox is enabled only outside production AND only while email is in
 * console mode (dev flag on, or SMTP unconfigured). This keeps links out of any
 * HTTP surface as soon as real mail delivery is configured or NODE_ENV=production.
 */
export function isDevOutboxEnabled(): boolean {
  if (isProduction) return false;
  return env.DEV_EMAIL_MODE || !smtpConfigured();
}

const MAX_ENTRIES = 50;
const entries: DevOutboxEntry[] = [];
let nextId = 1;

const URL_RE = /https?:\/\/\S+/;

/** Record a dev email (newest first). No-op unless the dev outbox is enabled. */
export function recordDevEmail(mail: {
  to: string;
  subject: string;
  text: string;
}): void {
  if (!isDevOutboxEnabled()) return;
  const link = mail.text.match(URL_RE)?.[0] ?? null;
  entries.unshift({
    id: nextId++,
    to: mail.to,
    subject: mail.subject,
    link,
    text: mail.text,
    createdAt: new Date().toISOString(),
  });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

/** All captured dev emails, newest first. */
export function listDevEmails(): DevOutboxEntry[] {
  return entries.slice();
}

/** Most recent dev email for a given recipient (case-insensitive), or null. */
export function latestDevEmailFor(email: string): DevOutboxEntry | null {
  const needle = email.trim().toLowerCase();
  return entries.find((e) => e.to.trim().toLowerCase() === needle) ?? null;
}

/** Clear the outbox (used by tests / manual reset). */
export function clearDevOutbox(): void {
  entries.length = 0;
}
