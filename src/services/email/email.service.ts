import nodemailer, { type Transporter } from "nodemailer";
import { env, isProduction } from "../../config/env.js";
import { BRANDING } from "../../config/branding.js";
import { recordDevEmail } from "./devOutbox.js";

/**
 * Transactional email (verification links + password resets).
 *
 * Dev/console mode: when DEV_EMAIL_MODE=true OR SMTP is not configured, emails
 * are printed to the backend console instead of being sent. This keeps local
 * development zero-config. In production a real SMTP config is required.
 */

function smtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT);
}

/** True when we should log links instead of sending real email. */
function useConsoleMode(): boolean {
  return env.DEV_EMAIL_MODE || !smtpConfigured();
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });
  }
  return transporter;
}

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function deliver(mail: Mail): Promise<void> {
  if (useConsoleMode()) {
    // Capture the email (with its link) in the dev-only in-memory outbox so the
    // full auth flow can be exercised without a real inbox. No-op in production.
    recordDevEmail({ to: mail.to, subject: mail.subject, text: mail.text });
    // Never print secrets; the link itself is the one-time token holder.
    console.log(
      [
        "",
        "📧 ─────────────────────────────────────────────────────────────",
        `   ${BRANDING.productName} email (DEV console mode — not actually sent)`,
        `   To:      ${mail.to}`,
        `   Subject: ${mail.subject}`,
        `   ${mail.text}`,
        "   ─────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return;
  }

  if (isProduction && !smtpConfigured()) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST/SMTP_PORT (and disable DEV_EMAIL_MODE) in production.",
    );
  }

  await getTransporter().sendMail({
    from: env.EMAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

/** Email a "verify your email + set your password" link. */
export async function sendVerificationEmail(
  email: string,
  verificationUrl: string,
): Promise<void> {
  const subject = `Verify your ${BRANDING.productName} email`;
  const text =
    `Welcome to ${BRANDING.productName}. Click the link below to verify your ` +
    `email and create your password.\n\n${verificationUrl}`;
  const html =
    `<p>Welcome to <strong>${BRANDING.productName}</strong>. Click the link ` +
    `below to verify your email and create your password.</p>` +
    `<p><a href="${verificationUrl}">${verificationUrl}</a></p>`;
  await deliver({ to: email, subject, text, html });
}

/** Email a password reset link. */
export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string,
): Promise<void> {
  const subject = `Reset your ${BRANDING.productName} password`;
  const text =
    `We received a request to reset your ${BRANDING.productName} password. ` +
    `Click the link below to choose a new one. If you did not request this, ` +
    `you can ignore this email.\n\n${resetUrl}`;
  const html =
    `<p>We received a request to reset your <strong>${BRANDING.productName}</strong> ` +
    `password. Click the link below to choose a new one. If you did not request ` +
    `this, you can ignore this email.</p>` +
    `<p><a href="${resetUrl}">${resetUrl}</a></p>`;
  await deliver({ to: email, subject, text, html });
}
