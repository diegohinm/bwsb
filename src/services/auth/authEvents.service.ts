import { query } from "../../lib/db.js";

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
    await query(
      `INSERT INTO public.auth_events
         (user_id, event_type, success, ip_address, user_agent, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.userId ?? null,
        event.eventType,
        event.success,
        event.ipAddress ?? null,
        event.userAgent ?? null,
        event.errorMessage ?? null,
      ],
    );
  } catch (err) {
    console.error("Failed to record auth event (continuing):", err);
  }
}
