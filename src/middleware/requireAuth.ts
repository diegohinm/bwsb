import type { NextFunction, Request, Response } from "express";

import {
  verifySessionToken,
  SESSION_COOKIE_NAME,
} from "../services/auth/session.service.js";

/**
 * requireAuth
 *
 * Guard for endpoints that need a signed-in user. Returns 401
 * `{ "error": "Authentication required" }` when there is no valid session.
 * On success `req.user` is guaranteed to be populated.
 *
 * Works whether or not optionalAuth ran earlier: if `req.user` is already set it
 * is reused, otherwise the yp_session cookie is validated here.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      const token = req.cookies?.[SESSION_COOKIE_NAME];
      if (typeof token === "string" && token) {
        const user = await verifySessionToken(token);
        if (user) req.user = user;
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
