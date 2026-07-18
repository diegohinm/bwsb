import { Router, type Request, type Response } from "express";

import { BRANDING } from "../config/branding.js";

export const healthRouter = Router();

/**
 * GET /health
 * Lightweight liveness check.
 */
healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: BRANDING.serviceName,
    product: BRANDING.productName,
    internalProjectName: BRANDING.internalProjectName,
    timestamp: new Date().toISOString(),
  });
});
