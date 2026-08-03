import { Router, type Request, type Response } from "express";

import {
  env,
  isProduction,
  isRedditOAuthConfigured,
  isGoogleOAuthConfigured,
} from "../config/env.js";
import { isAdminEmail } from "../config/adminAccess.js";
import { ok, fail, asyncHandler } from "../lib/response.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  requestEmailSignup,
  setPasswordAfterVerification,
  loginWithEmail,
  requestPasswordReset,
  resetPassword,
  normalizeEmail,
  isValidEmail,
} from "../services/auth/emailAuth.service.js";
import {
  isEmailDeliveryError,
  smtpErrorDetails,
} from "../services/email/EmailDeliveryError.js";
import {
  createSession,
  clearSession,
  verifySessionToken,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
} from "../services/auth/session.service.js";
import { logAuthEvent } from "../services/auth/authEvents.service.js";
import {
  isDevOutboxEnabled,
  listDevEmails,
  latestDevEmailFor,
} from "../services/email/devOutbox.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchRedditIdentity,
  generateState,
} from "../services/reddit.js";
import { upsertUserFromReddit } from "../services/user.js";
import {
  buildAuthorizeUrl as buildGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  fetchGoogleIdentity,
  generateState as generateGoogleState,
} from "../services/auth/google.js";
import { findOrCreateUserFromGoogle } from "../services/auth/googleAuth.service.js";

export const authRouter = Router();

/**
 * Only allow post-login redirects to internal, single-slash-rooted paths so a
 * crafted `returnTo` can never bounce the user to an external origin.
 */
function safeReturnTo(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string") return fallback;
  // Must start with a single "/" (reject "//evil.com" and "/\evil.com").
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  return value;
}

// ── Cookie helpers ────────────────────────────────────────────────────────────
function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction, // false locally, true in production
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

function ipOf(req: Request): string | null {
  return req.ip || req.socket.remoteAddress || null;
}
function uaOf(req: Request): string | null {
  return req.header("user-agent") ?? null;
}

// Rate limiters for the sensitive auth endpoints. The IP limiter is the
// middleware; the per-address limiter below is applied after the body is read.
const startLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "email-start" });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: "email-login" });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "pw-reset" });

// ═══════════════════════════════════════════════════════════════════════════
// Email + password auth (PRIMARY)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-address throttle for the signup link.
 *
 * The IP limiter alone does not stop one address being mail-bombed from a
 * botnet, and it is the RECIPIENT who suffers that. Fixed window, in memory —
 * same trade-off as the IP limiter, and it should move to a shared store when
 * the API runs on more than one instance.
 */
const EMAIL_START_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_START_MAX = 5;
const emailStartBuckets = new Map<string, { count: number; resetAt: number }>();

export function emailStartAllowed(normalizedEmail: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = emailStartBuckets.get(normalizedEmail);

  if (!bucket || now >= bucket.resetAt) {
    emailStartBuckets.set(normalizedEmail, { count: 1, resetAt: now + EMAIL_START_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (bucket.count >= EMAIL_START_MAX) {
    return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

/** Test hook — the buckets are process-wide and would leak between cases. */
export function __resetEmailStartLimiter(): void {
  emailStartBuckets.clear();
}

/**
 * How a failed send becomes an HTTP response.
 *
 * 502 for a delivery failure: the request was fine, the upstream mail server
 * was not. 500 for anything else. The message is always the generic one — the
 * SMTP wording names the sending account and would leak it to every caller.
 */
export function emailFailureResponse(
  err: unknown,
  message: string,
): { status: number; message: string } {
  return { status: isEmailDeliveryError(err) ? 502 : 500, message };
}

/**
 * POST /auth/email/start
 * Body: { email }
 *
 * Sends a verification / set-password link.
 *
 *   400  the address is not a valid email
 *   429  too many requests for this IP or this address
 *   502  the mail server refused the message — the link was NOT sent
 *   200  the message was accepted and the link is live
 *
 * The 502 is the point of this handler. It used to log the delivery failure and
 * answer 200 anyway, so the frontend told people to check an inbox that would
 * never receive anything, and the unusable token stayed in the database.
 *
 * Enumeration safety is unaffected: the response is identical whether or not
 * the address already has an account. An SMTP outage is infrastructure, not
 * information about a user, so it is reported honestly.
 */
authRouter.post(
  "/email/start",
  startLimiter,
  asyncHandler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    if (!isValidEmail(email)) {
      return fail(res, "Please enter a valid email address", 400);
    }

    const normalized = normalizeEmail(email);
    const throttle = emailStartAllowed(normalized);
    if (!throttle.allowed) {
      res.setHeader("Retry-After", String(throttle.retryAfter));
      return fail(res, "Too many requests. Please try again later.", 429);
    }

    try {
      await requestEmailSignup(email);
    } catch (err) {
      if (err instanceof Error && /valid email/i.test(err.message)) {
        return fail(res, err.message, 400);
      }

      // Server-side: the fields that identify the fault. Never the password,
      // never the token, never the link.
      console.error("[auth] email/start delivery failed", smtpErrorDetails(err));
      await logAuthEvent({
        eventType: "email_signup_requested",
        success: false,
        ipAddress: ipOf(req),
        userAgent: uaOf(req),
      });

      // Client-side: a generic message. A recipient does not need Gmail's
      // wording, and it would leak the sending account.
      const mapped = emailFailureResponse(err, "Unable to send verification email");
      return fail(res, mapped.message, mapped.status);
    }

    await logAuthEvent({
      eventType: "email_signup_requested",
      success: true,
      ipAddress: ipOf(req),
      userAgent: uaOf(req),
    });
    return ok(res, { ok: true, message: "Verification email sent" });
  }),
);

/**
 * POST /auth/email/set-password
 * Body: { token, password }
 * Verifies the email, sets the password, and starts a session.
 */
authRouter.post(
  "/email/set-password",
  asyncHandler(async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token) return fail(res, "Missing token", 400);

    try {
      const { userId } = await setPasswordAfterVerification(token, password);
      const sessionToken = await createSession(userId);
      setSessionCookie(res, sessionToken);
      await logAuthEvent({
        userId,
        eventType: "email_set_password",
        success: true,
        ipAddress: ipOf(req),
        userAgent: uaOf(req),
      });
      return ok(res, { ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not set password";
      await logAuthEvent({
        eventType: "email_set_password",
        success: false,
        ipAddress: ipOf(req),
        userAgent: uaOf(req),
        errorMessage: message,
      });
      return fail(res, message, 400);
    }
  }),
);

/**
 * POST /auth/email/login
 * Body: { email, password }
 * Sets the yt_session cookie and returns the user.
 */
authRouter.post(
  "/email/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    try {
      const sessionToken = await loginWithEmail(email, password);
      setSessionCookie(res, sessionToken);
      // Re-read the user for the response (login returns only a token).
      const user = await verifySessionToken(sessionToken);
      await logAuthEvent({
        userId: user?.id ?? null,
        eventType: "email_login",
        success: true,
        ipAddress: ipOf(req),
        userAgent: uaOf(req),
      });
      return ok(res, { user });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      await logAuthEvent({
        eventType: "email_login",
        success: false,
        ipAddress: ipOf(req),
        userAgent: uaOf(req),
        errorMessage: message,
      });
      return fail(res, message, 401);
    }
  }),
);

/**
 * POST /auth/logout
 * Destroys the session server-side and clears the cookie.
 */
authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (typeof token === "string" && token) {
      await clearSession(token);
    }
    clearSessionCookie(res);
    return ok(res, { ok: true });
  }),
);

/**
 * GET /auth/me
 * Returns the current user (from the yt_session cookie) or null.
 *
 * `isAdmin` is DERIVED here from the ADMIN_EMAILS allowlist — it is not stored
 * on the account (there is no role column). The frontend uses it only to decide
 * whether to show internal tooling; every internal endpoint re-checks server
 * side, so a client that lies about this gains nothing.
 */
authRouter.get(
  "/me",
  asyncHandler(async (req, res) =>
    ok(res, {
      user: req.user
        ? { ...req.user, isAdmin: isAdminEmail(req.user.email) }
        : null,
    }),
  ),
);

/**
 * POST /auth/password-reset/start
 * Body: { email }. Always returns ok (no enumeration).
 */
authRouter.post(
  "/password-reset/start",
  resetLimiter,
  asyncHandler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    try {
      await requestPasswordReset(email);
    } catch (err) {
      // Same rule as /email/start: an unknown address still returns 200 (no
      // enumeration), but a mail server that refused the message is reported —
      // otherwise the user waits forever for a reset that was never sent.
      console.error("[auth] password-reset/start delivery failed", smtpErrorDetails(err));
      const mapped = emailFailureResponse(err, "Unable to send password reset email");
      return fail(res, mapped.message, mapped.status);
    }
    return ok(res, { ok: true });
  }),
);

/**
 * POST /auth/password-reset/complete
 * Body: { token, password }.
 */
authRouter.post(
  "/password-reset/complete",
  asyncHandler(async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token) return fail(res, "Missing token", 400);

    try {
      await resetPassword(token, password);
      return ok(res, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not reset password";
      return fail(res, message, 400);
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Dev-only email outbox (verification / reset links)
// ═══════════════════════════════════════════════════════════════════════════
// When email runs in console mode (dev), the verification / reset links are only
// printed to the backend console. These endpoints expose the captured links so
// the full signup → set-password → login → reset flow can be exercised in QA
// WITHOUT a real inbox. They return 404 in production or once real SMTP is
// configured (see isDevOutboxEnabled), so genuine one-time links are never
// served over HTTP in a real deployment.

/** GET /auth/dev/outbox — recent dev emails (newest first). Dev/console only. */
authRouter.get("/dev/outbox", (_req: Request, res: Response) => {
  if (!isDevOutboxEnabled()) {
    res.status(404).json({ error: "Dev outbox is disabled" });
    return;
  }
  res.json({ enabled: true, emails: listDevEmails() });
});

/**
 * GET /auth/dev/last-email?email=... — most recent dev email + link for a
 * recipient. Dev/console only.
 */
authRouter.get("/dev/last-email", (req: Request, res: Response) => {
  if (!isDevOutboxEnabled()) {
    res.status(404).json({ error: "Dev outbox is disabled" });
    return;
  }
  const email = typeof req.query.email === "string" ? req.query.email : "";
  if (!email) {
    res.status(400).json({ error: "Provide ?email=" });
    return;
  }
  const entry = latestDevEmailFor(email);
  if (!entry) {
    res.status(404).json({ error: "No dev email found for that address" });
    return;
  }
  res.json(entry);
});

// ═══════════════════════════════════════════════════════════════════════════
// Reddit OAuth (OPTIONAL / future — disabled until configured)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /auth/reddit/config-check
 * Reports whether Reddit OAuth is configured. Never exposes secrets.
 */
authRouter.get("/reddit/config-check", (_req: Request, res: Response) => {
  return ok(res, {
    isConfigured: isRedditOAuthConfigured,
    redirectUri: env.REDDIT_REDIRECT_URI ?? null,
    hasUserAgent: Boolean(env.REDDIT_USER_AGENT),
  });
});

/**
 * GET /auth/reddit
 * Starts the OAuth handshake. Returns 503 when Reddit OAuth is not configured.
 */
authRouter.get("/reddit", (req: Request, res: Response) => {
  if (!isRedditOAuthConfigured) {
    res.status(503).json({ error: "Reddit OAuth is not configured yet" });
    return;
  }

  const state = generateState();
  req.session.oauthState = state;

  req.session.save((err) => {
    if (err) {
      console.error("Failed to save session before Reddit redirect:", err);
      res.redirect(`${env.FRONTEND_ORIGIN}/login?error=session`);
      return;
    }
    console.log("Redirecting to Reddit OAuth");
    res.redirect(buildAuthorizeUrl(state));
  });
});

/**
 * GET /auth/reddit/callback
 * Reddit redirects here. Preserved for future use. Also 503 when unconfigured.
 */
authRouter.get("/reddit/callback", async (req: Request, res: Response) => {
  if (!isRedditOAuthConfigured) {
    res.status(503).json({ error: "Reddit OAuth is not configured yet" });
    return;
  }

  const { code, state, error } = req.query;
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;

  const failRedirect = (reason: string) =>
    res.redirect(`${env.FRONTEND_ORIGIN}/login?error=${reason}`);

  if (typeof error === "string" && error) {
    return failRedirect("access_denied");
  }
  if (typeof state !== "string" || !expectedState || state !== expectedState) {
    return failRedirect("invalid_state");
  }
  if (typeof code !== "string" || !code) {
    return failRedirect("missing_code");
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const identity = await fetchRedditIdentity(accessToken);
    const user = await upsertUserFromReddit(identity);

    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error("Failed to regenerate session on login:", regenErr);
        return failRedirect("session");
      }
      req.session.userId = user.id;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("Failed to save authenticated session:", saveErr);
          return failRedirect("session");
        }
        res.redirect(`${env.FRONTEND_ORIGIN}/auth/callback`);
      });
    });
  } catch (err) {
    console.error("Reddit OAuth callback failed:", err);
    return failRedirect("oauth_failed");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Google OAuth (OPTIONAL — disabled until configured)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /auth/google/config-check
 * Reports whether Google OAuth is configured. Never exposes the client secret.
 */
authRouter.get("/google/config-check", (_req: Request, res: Response) => {
  return ok(res, {
    isConfigured: isGoogleOAuthConfigured,
    // Safe to surface: the redirect URI is public (registered with Google) and
    // is not a secret. The client id/secret are never returned.
    redirectUri: isGoogleOAuthConfigured ? env.GOOGLE_REDIRECT_URI : null,
  });
});

/**
 * GET /auth/google
 * Starts the OAuth handshake. Returns 503 when Google OAuth is not configured.
 * Preserves an internal `returnTo` for after login.
 */
authRouter.get("/google", (req: Request, res: Response) => {
  if (!isGoogleOAuthConfigured) {
    res.status(503).json({ error: "Google OAuth is not configured yet" });
    return;
  }

  const state = generateGoogleState();
  req.session.googleOAuthState = state;
  req.session.googleReturnTo = safeReturnTo(req.query.returnTo);

  req.session.save((err) => {
    if (err) {
      console.error("Failed to save session before Google redirect:", err);
      res.redirect(`${env.FRONTEND_ORIGIN}/login?error=session`);
      return;
    }
    res.redirect(buildGoogleAuthorizeUrl(state));
  });
});

/**
 * GET /auth/google/callback
 * Google redirects here. Verifies state, exchanges the code, finds/creates the
 * app_user by email, issues a normal yt_session, and redirects to the frontend.
 * Also 503 when unconfigured.
 */
authRouter.get("/google/callback", async (req: Request, res: Response) => {
  if (!isGoogleOAuthConfigured) {
    res.status(503).json({ error: "Google OAuth is not configured yet" });
    return;
  }

  const { code, state, error } = req.query;
  const expectedState = req.session.googleOAuthState;
  const returnTo = safeReturnTo(req.session.googleReturnTo);
  delete req.session.googleOAuthState;
  delete req.session.googleReturnTo;

  const failRedirect = (reason: string) =>
    res.redirect(`${env.FRONTEND_ORIGIN}/login?error=${reason}`);

  if (typeof error === "string" && error) {
    return failRedirect("access_denied");
  }
  if (typeof state !== "string" || !expectedState || state !== expectedState) {
    return failRedirect("invalid_state");
  }
  if (typeof code !== "string" || !code) {
    return failRedirect("missing_code");
  }

  try {
    const accessToken = await exchangeGoogleCode(code);
    const identity = await fetchGoogleIdentity(accessToken);
    const { userId } = await findOrCreateUserFromGoogle(identity);

    // Issue the SAME session type as email login (yt_session httpOnly cookie).
    const sessionToken = await createSession(userId);
    setSessionCookie(res, sessionToken);

    await logAuthEvent({
      userId,
      eventType: "google_login",
      success: true,
      ipAddress: ipOf(req),
      userAgent: uaOf(req),
    });

    return res.redirect(`${env.FRONTEND_ORIGIN}${returnTo}`);
  } catch (err) {
    console.error("Google OAuth callback failed:", err);
    await logAuthEvent({
      eventType: "google_login",
      success: false,
      ipAddress: ipOf(req),
      userAgent: uaOf(req),
      errorMessage: err instanceof Error ? err.message : "google_oauth_failed",
    });
    return failRedirect("oauth_failed");
  }
});
