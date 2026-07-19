import "express-session";

/**
 * Fields we store on the server-side session. The session cookie only carries
 * an opaque session id — none of these values are ever sent to the client.
 */
declare module "express-session" {
  interface SessionData {
    /** Authenticated local user id (User.id). Presence means "logged in". */
    userId?: string;
    /** One-time CSRF token for the in-flight Reddit OAuth handshake. */
    oauthState?: string;
  }
}
