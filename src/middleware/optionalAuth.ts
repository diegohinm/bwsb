import type { NextFunction, Request, Response } from "express";

import {
  verifySessionToken,
  SESSION_COOKIE_NAME,
} from "../services/auth/session.service.js";

/**
 * optionalAuth
 *
 * Best-effort authentication. Reads the httpOnly `yt_session` cookie; if it maps
 * to a valid, unexpired session the corresponding user is attached to
 * `req.user`. If there is no cookie or it is invalid, the request simply
 * continues as anonymous — public endpoints must never fail here.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (typeof token === "string" && token) {
      const user = await verifySessionToken(token);
      if (user) req.user = user;
    }
  } catch (err) {
    // Never block a public request because auth lookup failed.
    console.error("optionalAuth lookup failed (continuing anonymous):", err);
  }
  next();
}
