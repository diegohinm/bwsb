import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import {
  internalAccessOpenByEnvironment,
  isAdminEmail,
} from "../config/adminAccess.js";

/**
 * Gate for INTERNAL tooling endpoints (the Reddit provider diagnostics).
 *
 * Access is granted when ANY of these holds:
 *   1. this is not a production environment — local dev and tests are open;
 *   2. the request carries a valid `x-admin-secret` (server-to-server / curl);
 *   3. a signed-in user's email is in ADMIN_EMAILS.
 *
 * Otherwise: 403. Never 401 — a 401 would invite a login prompt for a page
 * that is not meant to exist for normal users, and the response deliberately
 * does not say WHICH condition failed.
 *
 * `optionalAuth` runs globally before the routers, so `req.user` is already
 * populated when a valid session cookie is present.
 */

export interface InternalAccessInput {
  /** True outside production, where internal tooling is open to everyone. */
  openByEnvironment: boolean;
  /** Configured ADMIN_SECRET, if any. */
  adminSecret?: string | undefined;
  /** Value of the `x-admin-secret` request header, if any. */
  providedSecret?: string | undefined;
  /** Email of the signed-in user, if any. */
  userEmail?: string | null | undefined;
  /** Allowlist check, injectable so production rules can be tested. */
  isAdmin?: (email: string | null | undefined) => boolean;
}

/**
 * The access decision, extracted from Express so it can be exercised with a
 * production-like environment without booting the app in production mode.
 */
export function isInternalAccessAllowed(input: InternalAccessInput): boolean {
  if (input.openByEnvironment) return true;

  if (
    input.adminSecret &&
    input.providedSecret &&
    input.providedSecret === input.adminSecret
  ) {
    return true;
  }

  const adminCheck = input.isAdmin ?? isAdminEmail;
  return adminCheck(input.userEmail);
}

export function requireInternalOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const allowed = isInternalAccessAllowed({
    openByEnvironment: internalAccessOpenByEnvironment,
    adminSecret: env.ADMIN_SECRET,
    providedSecret: req.header("x-admin-secret") ?? undefined,
    userEmail: req.user?.email,
  });

  if (allowed) {
    next();
    return;
  }

  res.status(403).json({ error: "Forbidden" });
}
