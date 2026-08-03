import nodemailer, { type Transporter } from "nodemailer";

import { BRANDING } from "../../config/branding.js";
import {
  describeSmtp,
  getSmtpConfig,
  isSmtpConfigured,
  useConsoleEmailMode,
} from "../../config/smtp.js";
import { recordDevEmail } from "./devOutbox.js";
import { EmailDeliveryError, smtpErrorDetails } from "./EmailDeliveryError.js";

/**
 * Transactional email (verification links + password resets).
 *
 * ONE transporter for the process, created lazily and reused. Building one per
 * request throws away the pooled connection and re-authenticates against Gmail
 * every time, which is both slower and a good way to get rate-limited.
 *
 * TWO MODES:
 *   console — DEV_EMAIL_MODE, or no usable SMTP config, outside production.
 *             The message is printed and captured in the dev outbox. This is a
 *             genuine delivery for the caller's purposes: the link is reachable.
 *   smtp    — a real send. If it throws, the caller gets an EmailDeliveryError
 *             and MUST NOT report success.
 *
 * What this module never does: log the password, the token, or the full link.
 */

let transporter: Transporter | null = null;

/** The process-wide transporter. Throws a configuration error if unusable. */
export function getTransporter(): Transporter {
  if (!transporter) {
    const config = getSmtpConfig();
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
    });
  }
  return transporter;
}

/** Drop the cached transporter — used after a configuration change. */
export function resetTransporter(): void {
  transporter = null;
}

/**
 * Install a stand-in transporter.
 *
 * The seam tests use so nothing reaches a real mail server. Production never
 * calls it; `resetTransporter()` puts things back.
 */
export function setTransporterForTesting(fake: Transporter | null): void {
  transporter = fake;
}

/**
 * Ask the mail server whether the configuration actually works.
 *
 * Called at boot so a bad app password is discovered on the first line of the
 * log rather than by the first user who tries to sign up. It NEVER blocks
 * startup: an API that refuses to serve public pages because SMTP is wrong has
 * turned one broken feature into an outage.
 */
export async function verifyEmailTransport(): Promise<boolean> {
  if (useConsoleEmailMode()) {
    console.info("[email] console mode — messages are printed, not sent", describeSmtp());
    return true;
  }

  if (!isSmtpConfigured()) {
    console.warn(
      "[email] SMTP is not configured; verification and reset emails cannot be sent.",
      describeSmtp(),
    );
    return false;
  }

  try {
    await getTransporter().verify();
    console.info("[email] SMTP ready", describeSmtp());
    return true;
  } catch (err) {
    // The most common cause by far, so it is named rather than left to be
    // rediscovered: a Google app password is 16 characters with no spaces.
    console.error(
      "[email] SMTP verification FAILED — verification and reset emails will not be delivered.",
      { ...describeSmtp(), ...smtpErrorDetails(err) },
    );
    return false;
  }
}

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Hand one message to the mail server.
 *
 * Resolves ONLY when the message was accepted (or captured in console mode).
 * Every failure becomes an EmailDeliveryError — there is no path through this
 * function that swallows an error, because the endpoint above it decides
 * whether to tell the user their email is on its way.
 */
async function deliver(mail: Mail): Promise<void> {
  if (useConsoleEmailMode()) {
    recordDevEmail({ to: mail.to, subject: mail.subject, text: mail.text });
    console.info(`[email] (console mode) ${mail.subject} → ${mail.to}`);
    console.info(mail.text);
    return;
  }

  if (!isSmtpConfigured()) {
    throw new EmailDeliveryError(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD.",
    );
  }

  const config = getSmtpConfig();
  try {
    const info = await getTransporter().sendMail({
      from: config.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    // messageId is an internal correlation id: useful in the server log, never
    // part of a public response.
    console.info("[email] sent", { to: mail.to, subject: mail.subject, messageId: info.messageId });
  } catch (err) {
    console.error("[email] send failed", {
      to: mail.to,
      subject: mail.subject,
      ...smtpErrorDetails(err),
    });
    throw new EmailDeliveryError("Unable to deliver email", { cause: err });
  }
}

/** Email a "verify your email + set your password" link. */
export async function sendVerificationEmail(
  email: string,
  verificationUrl: string,
): Promise<void> {
  const subject = `Verify your ${BRANDING.productName} email`;
  const text =
    `Welcome to ${BRANDING.productName}. Click the link below to verify your ` +
    `email and create your password.\n\n${verificationUrl}\n\n` +
    `This link expires in 24 hours and can only be used once. If you did not ` +
    `request it, you can ignore this email.`;
  const html =
    `<p>Welcome to <strong>${BRANDING.productName}</strong>. Click the link ` +
    `below to verify your email and create your password.</p>` +
    `<p><a href="${verificationUrl}">${verificationUrl}</a></p>` +
    `<p>This link expires in 24 hours and can only be used once. If you did ` +
    `not request it, you can ignore this email.</p>`;
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

export { EmailDeliveryError };
