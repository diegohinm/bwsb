import type { Response } from "express";

/**
 * Standard API envelopes.
 *   success -> { "data": ... }
 *   error   -> { "error": "Human readable error" }
 */

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ data });
}

export function fail(res: Response, message: string, status = 400): Response {
  return res.status(status).json({ error: message });
}

/**
 * Wrap an async route handler so thrown errors become a clean 500 JSON error
 * instead of an unhandled rejection. Keeps every route try/catch-free.
 */
export function asyncHandler(
  handler: (req: import("express").Request, res: Response) => Promise<unknown>,
) {
  return (req: import("express").Request, res: Response) => {
    handler(req, res).catch((err: unknown) => {
      console.error("Route error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    });
  };
}
