import type { NextFunction, Request, Response } from "express";

import { findUserById, toPublicUser } from "../services/user.js";

/**
 * optionalAuth
 *
 * Best-effort authentication. If the request carries a valid session (the
 * Reddit OAuth cookie set by /auth/reddit/callback), the corresponding user is
 * attached to `req.user`. If there is no session or it is invalid, the request
 * simply continues as anonymous — public endpoints must never fail here.
 *
 * NOTE: This app authenticates via a PostgreSQL-backed HttpOnly session cookie
 * (express-session), not a bearer token. If token auth is added later, read and
 * validate `Authorization: Bearer <token>` here and attach the same `req.user`.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.session?.userId;
    if (userId) {
      const user = await findUserById(userId);
      if (user) req.user = toPublicUser(user);
    }
  } catch (err) {
    // Never block a public request because auth lookup failed.
    console.error("optionalAuth lookup failed (continuing anonymous):", err);
  }
  next();
}
