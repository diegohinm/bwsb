import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Guard for the service-to-service endpoints the ingestion worker calls.
 *
 * FAILS CLOSED. With WORKER_INTERNAL_SECRET unset every request is refused —
 * an internal broadcast channel that anyone can post to is worse than one that
 * does not work, because the failure is silent and the abuse is not.
 *
 * The comparison is constant-time. A naive `===` leaks the shared secret one
 * byte at a time to anyone who can measure the response, and this endpoint can
 * be called as often as an attacker likes.
 *
 * Nothing here is ever logged: not the header, not the expected value, not a
 * prefix of either.
 */

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal — compare lengths first and still run the check.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function requireWorkerSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Read from process.env at call time, not from the module-level parsed env.
  // That object is frozen at import, which makes the guard impossible to
  // exercise with different configurations — and this is precisely the code
  // whose configurations need testing.
  const expected = process.env.WORKER_INTERNAL_SECRET?.trim();
  if (!expected) {
    console.error(
      "[InternalRedditEvent] refused: WORKER_INTERNAL_SECRET is not configured on this service.",
    );
    res.status(503).json({ error: "Internal events are not configured" });
    return;
  }

  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token || !safeEqual(token, expected)) {
    // Deliberately identical for a missing, malformed and wrong token: the
    // caller is a service that either has the secret or does not.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
