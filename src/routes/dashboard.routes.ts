import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { getDashboardTickerStrip } from "../services/dashboard/tickerStrip.service.js";
import { isPulseTimeframe, PULSE_TIMEFRAMES } from "../services/social/index.js";

export const dashboardRouter = Router();

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * GET /api/dashboard/ticker-strip?timeframe=1h|6h|24h|7d&limit=12
 *
 * Public, read-only. One consolidated list for the dashboard's moving ticker
 * tape: the most-mentioned tickers on Reddit (social provider) enriched with
 * quotes (market provider). Always resolves — mock fallback on either side —
 * with `meta.isMock` / `meta.warning` telling the client when to badge demo data.
 */
dashboardRouter.get(
  "/dashboard/ticker-strip",
  asyncHandler(async (req, res) => {
    const rawTimeframe = req.query.timeframe ?? "24h";
    if (!isPulseTimeframe(rawTimeframe)) {
      return fail(
        res,
        `Unsupported timeframe. Use one of: ${PULSE_TIMEFRAMES.join(", ")}.`,
        400,
      );
    }

    const limitNum = Number(firstString(req.query.limit));
    const limit = Number.isFinite(limitNum)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitNum)))
      : DEFAULT_LIMIT;

    const result = await getDashboardTickerStrip({ timeframe: rawTimeframe, limit });
    return ok(res, result);
  }),
);
