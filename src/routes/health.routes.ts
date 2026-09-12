import { Router, type Request, type Response } from "express";

import { BRANDING } from "../config/branding.js";
import { env } from "../config/env.js";
import { snapshot } from "../lib/metrics.js";

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

/**
 * GET /health/metrics — this process's counters.
 *
 * THE POINT OF THIS ENDPOINT is making one claim checkable: that a normal
 * Discussion session costs no provider requests. On the API process
 * `databento_requests` is supposed to read 0 no matter how much Reddit traffic
 * has been served, and `market_cache_hits` is supposed to grow while it stays
 * there. The worker reports its own set separately, where the Databento count
 * is SUPPOSED to move — that is the only process allowed to make it move.
 *
 * In-process and reset by every restart, which is why `uptimeSeconds` is part of
 * the payload: a counter without a window is not a measurement. It is not a
 * metrics backend and is not meant to become one — see lib/metrics.ts.
 *
 * Separate from /health on purpose: the liveness probe must keep touching
 * nothing, and must not start failing because a counter serializer threw.
 */
healthRouter.get("/health/metrics", (_req: Request, res: Response) => {
  res.json({
    service: BRANDING.serviceName,
    role: env.SERVICE_ROLE,
    ...snapshot(),
    timestamp: new Date().toISOString(),
  });
});
