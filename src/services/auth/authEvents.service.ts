import { prisma } from "../../lib/prisma.js";

/**
 * Append-only audit trail for auth-related actions. Best-effort: a logging
 * failure must never break the actual auth flow. Never pass secrets here
 * (passwords, raw tokens) — only event metadata.
 */
export interface AuthEventInput {
  userId?: string | null;
  eventType: string;
  success: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
  errorMessage?: string | null;
}

export async function logAuthEvent(event: AuthEventInput): Promise<void> {
  try {
    await prisma.authEvents.create({
      data: {
        userId: event.userId ?? null,
        eventType: event.eventType,
        success: event.success,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
        errorMessage: event.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error("Failed to record auth event (continuing):", err);
  }
}
