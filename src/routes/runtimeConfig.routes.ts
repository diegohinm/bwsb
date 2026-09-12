import { Router, type Request, type Response } from "express";

import { ok } from "../lib/response.js";
import { requireWorkerSecret } from "../middleware/requireWorkerSecret.js";
import {
  ACTIVE_REDDIT_COMMUNITIES,
  ALLOW_REDDIT_COMMUNITY_SELECTION,
  activeCommunityOptions,
} from "../config/redditCommunities.js";

/**
 * RUNTIME CONFIGURATION — how the worker and the frontend learn what the
 * backend has been told.
 *
 * `REDDIT_ACTIVE_COMMUNITIES` lives in exactly one `.env`, on this service.
 * These two endpoints are how that single value reaches the other two
 * processes, so that changing it never means editing three configurations and
 * hoping they agree.
 *
 * TWO ENDPOINTS, NOT ONE, because they have different audiences and therefore
 * different contents:
 *
 *   /internal/runtime-config   worker. Authenticated. The operational shape —
 *                              bare ids, which is what an ingestion loop needs.
 *   /api/runtime-config        browser. Public. The presentational shape —
 *                              ids with labels, plus whether to render a picker.
 *
 * NEITHER RETURNS A SECRET. No API keys, no DATABASE_URL, no tokens. What goes
 * out is the answer to one question — which communities are active — and the
 * few things derived from it.
 */

/**
 * TWO ROUTERS because they mount at different roots: the internal one at "/" so
 * its path is `/internal/runtime-config`, the public one under "/api". Mounting
 * a single router under "/api" would have produced
 * `/api/internal/runtime-config`, which reads like a public endpoint.
 */
export const internalRuntimeConfigRouter = Router();
export const runtimeConfigRouter = Router();

/**
 * GET /internal/runtime-config — the worker's authority on scope.
 *
 * Guarded by the shared worker secret, which FAILS CLOSED: with
 * WORKER_INTERNAL_SECRET unset every request is refused. That is the right
 * direction here — a worker that cannot authenticate gets no configuration, and
 * a worker with no configuration makes no Mindcase requests at all.
 */
internalRuntimeConfigRouter.get(
  "/internal/runtime-config",
  requireWorkerSecret,
  (_req: Request, res: Response) => {
    res.json({
      reddit: {
        activeCommunities: [...ACTIVE_REDDIT_COMMUNITIES],
        allowCommunitySelection: ALLOW_REDDIT_COMMUNITY_SELECTION,
      },
    });
  },
);

/**
 * GET /api/runtime-config — what the browser is allowed to know.
 *
 * The frontend has no community list of its own and no `VITE_` variable for
 * one. It renders what this says, including whether a selector should exist at
 * all — so activating a second community is a backend restart, not a frontend
 * deploy.
 *
 * Public and unauthenticated: the set of subreddits a public product reads is
 * not a secret, and requiring a session would mean the shell could not render
 * before login.
 */
runtimeConfigRouter.get("/runtime-config", (_req: Request, res: Response) => {
  return ok(res, {
    reddit: {
      communities: activeCommunityOptions(),
      // DERIVED from the list, never configured beside it — the two cannot
      // contradict each other. One community means nothing to choose between.
      allowCommunitySelection: ALLOW_REDDIT_COMMUNITY_SELECTION,
    },
  });
});
