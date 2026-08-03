import { Router, type Request, type Response } from "express";

import { BRANDING } from "../config/branding.js";

export const healthRouter = Router();

/**
 * GET /health — the platform's liveness probe.
 *
 * Deliberately touches NOTHING: no database round-trip, no provider, no cache.
 * A health check that queries Postgres turns a slow database into a restart
 * loop, and one that reaches Arctic Shift makes an upstream outage look like a
 * dead service. This answers "is the process serving HTTP", which is the only
 * question the probe is asking.
 *
 * `ok` is kept alongside `status` so existing callers do not break.
 */
healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    ok: true,
    service: BRANDING.serviceName,
    product: BRANDING.productName,
    internalProjectName: BRANDING.internalProjectName,
    timestamp: new Date().toISOString(),
  });
});
