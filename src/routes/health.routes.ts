import { Router, type Request, type Response } from "express";

export const healthRouter = Router();

/**
 * GET /health
 * Lightweight liveness check.
 */
healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "reddit-radar-bwsb",
    timestamp: new Date().toISOString(),
  });
});
