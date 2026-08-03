/**
 * A message could not be handed to the mail server.
 *
 * It exists so the route layer can tell "we failed to send" apart from every
 * other failure and answer 502 instead of 200. The `cause` carries the SMTP
 * error for the server log; nothing on this class is safe to show a user, and
 * callers are expected to substitute a generic message.
 */
export class EmailDeliveryError extends Error {
  public readonly code = "EMAIL_DELIVERY_FAILED";

  constructor(message = "Unable to deliver email", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmailDeliveryError";
  }
}

export function isEmailDeliveryError(err: unknown): err is EmailDeliveryError {
  return err instanceof EmailDeliveryError;
}

/**
 * The SMTP fields worth logging: enough to diagnose an EAUTH or a refused
 * recipient, and nothing that could carry a credential, a token or a link.
 *
 * Deliberately an allowlist. Logging the whole error object would eventually
 * print something it should not — nodemailer attaches the full envelope, and
 * some transports attach the auth payload.
 */
export function smtpErrorDetails(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object") return { message: String(err) };
  const e = err as Record<string, unknown>;
  return {
    name: typeof e.name === "string" ? e.name : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
    responseCode: typeof e.responseCode === "number" ? e.responseCode : undefined,
    command: typeof e.command === "string" ? e.command : undefined,
  };
}
