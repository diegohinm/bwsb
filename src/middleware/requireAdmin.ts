import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";

/**
 * requireAdmin
 *
 * Guard for admin-only endpoints (e.g. manual Reddit-verification review). Auth
 * is a shared secret passed in the `x-admin-secret` header, compared against
 * ADMIN_SECRET. This is intentionally NOT tied to normal user sessions — public
 * users must never reach these routes.
 *
 * Returns 403 when ADMIN_SECRET is unset (admin disabled) or the header is
 * missing/incorrect. The secret is never logged.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = env.ADMIN_SECRET;
  const provided = req.header("x-admin-secret");

  if (!expected || !provided || provided !== expected) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
