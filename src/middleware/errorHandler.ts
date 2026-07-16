import { type NextFunction, type Request, type Response } from "express";

/**
 * Generic Express error handler.
 *
 * Must keep all four parameters so Express recognizes it as an
 * error-handling middleware.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Log the real error server-side; return a generic message to the client.
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
}
