import type { NextFunction, Request, Response } from "express";

/**
 * Minimal in-memory fixed-window rate limiter, keyed by client IP + route. Good
 * enough to blunt brute-force / email-bombing on auth endpoints in a single
 * instance. For multi-instance production, swap for a shared store (Redis).
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(options: {
  windowMs: number;
  max: number;
  key?: string;
}) {
  const { windowMs, max, key = "rl" } = options;
  const buckets = new Map<string, Bucket>();

  return function rateLimiter(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const bucketKey = `${key}:${ip}`;
    const now = Date.now();

    const existing = buckets.get(bucketKey);
    if (!existing || now >= existing.resetAt) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (existing.count >= max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }

    existing.count += 1;
    next();
  };
}
