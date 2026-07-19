import { Router, type Request, type Response } from "express";

import { env } from "../config/env.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchRedditIdentity,
  generateState,
} from "../services/reddit.js";
import {
  findUserById,
  toPublicUser,
  upsertUserFromReddit,
} from "../services/user.js";

export const authRouter = Router();

/**
 * GET /auth/reddit
 *
 * Start the OAuth handshake: generate a random `state`, store it on the
 * session (CSRF protection), then redirect the browser to Reddit's
 * authorization page. This must be reached via a full-page browser redirect,
 * not fetch().
 */
authRouter.get("/reddit", (req: Request, res: Response) => {
  const state = generateState();
  req.session.oauthState = state;

  // Persist the session before redirecting so the state is durably stored.
  req.session.save((err) => {
    if (err) {
      console.error("Failed to save session before Reddit redirect:", err);
      res.redirect(`${env.FRONTEND_URL}/login?error=session`);
      return;
    }
    res.redirect(buildAuthorizeUrl(state));
  });
});

/**
 * GET /auth/reddit/callback
 *
 * Reddit redirects here with `code` and `state`. We validate state, exchange
 * the code for an access token, read the Reddit identity, upsert the local
 * user, and establish an authenticated session. The access token is used once
 * and discarded — it is never persisted or sent to the client.
 */
authRouter.get("/reddit/callback", async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  const expectedState = req.session.oauthState;

  // The one-time state is consumed regardless of outcome.
  delete req.session.oauthState;

  const failRedirect = (reason: string) =>
    res.redirect(`${env.FRONTEND_URL}/login?error=${reason}`);

  // User denied the authorization prompt, or Reddit returned an error.
  if (typeof error === "string" && error) {
    return failRedirect("access_denied");
  }

  // CSRF check: state must be present and match what we stored.
  if (
    typeof state !== "string" ||
    !expectedState ||
    state !== expectedState
  ) {
    return failRedirect("invalid_state");
  }

  if (typeof code !== "string" || !code) {
    return failRedirect("missing_code");
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const identity = await fetchRedditIdentity(accessToken);
    const user = await upsertUserFromReddit(identity);

    // Regenerate the session id on login to prevent session fixation, then
    // mark the new session as authenticated.
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
        res.redirect(`${env.FRONTEND_URL}/auth/callback`);
      });
    });
  } catch (err) {
    console.error("Reddit OAuth callback failed:", err);
    return failRedirect("oauth_failed");
  }
});

/**
 * GET /auth/me
 *
 * Returns the authenticated user, or 401 when there is no active session.
 */
authRouter.get("/me", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    return res.status(401).json({ authenticated: false });
  }

  const user = await findUserById(req.session.userId);

  if (!user) {
    // Session points at a user that no longer exists — clear it.
    req.session.destroy(() => undefined);
    return res.status(401).json({ authenticated: false });
  }

  return res.json({ authenticated: true, user: toPublicUser(user) });
});

/**
 * POST /auth/logout
 *
 * Destroys the session server-side and clears the session cookie.
 */
authRouter.post("/logout", (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Failed to destroy session on logout:", err);
      return res.status(500).json({ error: "Failed to log out" });
    }
    res.clearCookie("stonkterminal.sid");
    return res.json({ success: true });
  });
});
