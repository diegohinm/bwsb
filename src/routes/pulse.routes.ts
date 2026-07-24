import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import {
  getPulse,
  getProviderStatus,
  isPulseTimeframe,
  PULSE_TIMEFRAMES,
} from "../services/social/index.js";
import { TRACKED_SUBREDDITS } from "../services/social/subreddits.js";

export const pulseRouter = Router();

/**
 * GET /api/pulse?timeframe=1h|6h|24h|7d
 *
 * Public. Cross-subreddit trending for investing communities. Contains no
 * portfolio, P/L, copy-trade or arena data — Pulse is a market-wide read only.
 *
 * Returns `{ snapshot: null, provider: {...} }` when the provider is disabled so
 * the client can render an explicit empty state instead of a broken page.
 */
pulseRouter.get(
  "/pulse",
  asyncHandler(async (req, res) => {
    const raw = req.query.timeframe ?? "24h";
    if (!isPulseTimeframe(raw)) {
      return fail(
        res,
        `Unsupported timeframe. Use one of: ${PULSE_TIMEFRAMES.join(", ")}.`,
        400,
      );
    }

    const provider = getProviderStatus();
    const snapshot = await getPulse(raw);

    return ok(res, {
      snapshot,
      provider,
      timeframes: PULSE_TIMEFRAMES,
      trackedSubreddits: TRACKED_SUBREDDITS,
    });
  }),
);

/**
 * GET /api/pulse/provider — which social data provider is active.
 * Never exposes API keys.
 */
pulseRouter.get("/pulse/provider", (_req, res) => {
  ok(res, getProviderStatus());
});
