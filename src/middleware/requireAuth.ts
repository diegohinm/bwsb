import type { NextFunction, Request, Response } from "express";

/**
 * Guard for routes that require an authenticated session. Responds 401 when no
 * `userId` is present on the session. Use on any protected API route.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.session.userId) {
    res.status(401).json({ authenticated: false, error: "Not authenticated" });
    return;
  }
  next();
}
