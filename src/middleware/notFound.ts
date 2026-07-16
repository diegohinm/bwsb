import { type Request, type Response } from "express";

/**
 * Catch-all 404 handler for unmatched routes.
 */
export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Route not found" });
}
