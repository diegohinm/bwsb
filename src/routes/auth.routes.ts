import { Router, type Request, type Response } from "express";

import { env, isProduction, isRedditOAuthConfigured } from "../config/env.js";
import { ok, fail, asyncHandler } from "../lib/response.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  requestEmailSignup,
  setPasswordAfterVerification,
  loginWithEmail,
  requestPasswordReset,
  resetPassword,
} from "../services/auth/emailAuth.service.js";
import {
  createSession,
  clearSession,
  verifySessionToken,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
} from "../services/auth/session.service.js";
import { logAuthEvent } from "../services/auth/authEvents.service.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchRedditIdentity,
  generateState,
} from "../services/reddit.js";
import { upsertUserFromReddit } from "../services/user.js";

export const authRouter = Router();

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

// Rate limiters for the sensitive auth endpoints.
const startLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "email-start" });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: "email-login" });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "pw-reset" });

// ═══════════════════════════════════════════════════════════════════════════
// Email + password auth (PRIMARY)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/email/start
 * Body: { email }
 * Sends a verification / set-password link. Always returns ok to prevent email
 * enumeration (a genuinely malformed email is the only 400).
 */
authRouter.post(
  "/email/start",
  startLimiter,
  asyncHandler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    try {
      await requestEmailSignup(email);
    } catch (err) {
      // Format errors are safe to surface; anything else must not leak.
      if (err instanceof Error && /valid email/i.test(err.message)) {
        return fail(res, err.message, 400);
      }
      console.error("email/start failed:", err);
    }
    await logAuthEvent({
      eventType: "email_signup_requested",
      success: true,
      ipAddress: ipOf(req),
      userAgent: uaOf(req),
    });
    return ok(res, { ok: true });
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
 */
authRouter.get(
  "/me",
  asyncHandler(async (req, res) => ok(res, { user: req.user ?? null })),
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
      console.error("password-reset/start failed:", err);
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
