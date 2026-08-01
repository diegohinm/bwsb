import { Router } from "express";

import { arcticShiftWorkerConfig, redditConfig } from "../config/reddit.config.js";
import { getRedditDataConfig } from "../config/redditDataConfig.js";
import { fail, ok } from "../lib/response.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireInternalOrAdmin } from "../middleware/requireInternalOrAdmin.js";
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

/**
 * GET /api/internal/reddit/config
 *
 * The ingestion configuration an operator needs to read the scanner page: which
 * communities the worker rotates through, how fast it rotates, and which
 * provider mode is active.
 *
 * SAFE BY CONSTRUCTION — the response is BUILT FIELD BY FIELD from values that
 * are already public knowledge inside the product. No API key, no token, no
 * base URL, no header, and no `...spread` of a config object that might grow a
 * secret later. Guarded by `requireInternalOrAdmin`, the same middleware as the
 * scanner itself.
 */
internalRedditRouter.get(
  "/internal/reddit/config",
  requireInternalOrAdmin,
  (_req, res) => {
    let providerMode = "unknown";
    try {
      providerMode = getRedditDataConfig().mode;
    } catch {
      // An invalid provider configuration must not hide the subreddit list —
      // that list is exactly what the operator came to check.
    }

    ok(res, {
      subreddits: [...redditConfig.subreddits],
      pollIntervalMs: redditConfig.pollIntervalMs,
      providerMode,
      postLimit: redditConfig.postLimit,
      workerEnabled: arcticShiftWorkerConfig.enabled,
      /** Reddit lists come from REDDIT_SUBREDDITS; edits need a restart. */
      source: redditConfig.source,
    });
  },
);

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
