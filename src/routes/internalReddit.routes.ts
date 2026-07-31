import { Router } from "express";

import { getRedditDataConfig } from "../config/redditDataConfig.js";
import { fail, ok } from "../lib/response.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { sanitizeProviderError } from "../providers/reddit/providerErrors.js";
import { getRedditProvidersStatus } from "../providers/reddit/RedditProviderFactory.js";

/**
 * INTERNAL diagnostics for the Reddit provider layer.
 *
 *   GET /api/internal/reddit/providers/status
 *
 * ADMIN ONLY — guarded by `requireAdmin` (the `x-admin-secret` header), and
 * returning 403 outright when ADMIN_SECRET is unset. It reveals which upstreams
 * are wired up and how they are behaving, which is operator information, not
 * public information. No credential is ever included in the response: only
 * whether one is present.
 *
 * READ-ONLY AND OFFLINE: the response is built from configuration plus the
 * in-process health counters. It performs no provider call, so polling it can
 * never make a degraded provider worse — and it is not a health check the
 * dashboard depends on. The frontend always reads PostgreSQL.
 *
 * NOTE ON PROCESSES: health counters are per-process, and the WORKER is the
 * process that calls providers. Served from the API this reports configuration
 * with counters at zero; run it against the worker for live call history.
 */
export const internalRedditRouter = Router();

internalRedditRouter.get(
  "/internal/reddit/providers/status",
  requireAdmin,
  (_req, res) => {
    try {
      const status = getRedditProvidersStatus(getRedditDataConfig());
      ok(res, status);
    } catch (error) {
      // An invalid REDDIT_* configuration must be visible here — this endpoint
      // is exactly where an operator looks to find out why ingestion is dead.
      fail(res, sanitizeProviderError(error), 500);
    }
  },
);
