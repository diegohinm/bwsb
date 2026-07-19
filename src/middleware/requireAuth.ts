import type { NextFunction, Request, Response } from "express";

import { findUserById, toPublicUser } from "../services/user.js";

/**
 * requireAuth
 *
 * Guard for endpoints that need a signed-in user. Returns 401
 * `{ "error": "Authentication required" }` when there is no valid session.
 * On success `req.user` is guaranteed to be populated.
 *
 * Works whether or not optionalAuth ran earlier: if `req.user` is already set
 * it is reused, otherwise the session is validated here.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      const userId = req.session?.userId;
      if (userId) {
        const user = await findUserById(userId);
        if (user) req.user = toPublicUser(user);
      }
    }
  } catch (err) {
    console.error("requireAuth lookup failed:", err);
  }

  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  next();
}
