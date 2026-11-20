import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { getDashboardTickerStrip } from "../services/dashboard/tickerStrip.service.js";
import { getDashboardMarketPulse } from "../services/dashboard/marketPulse.service.js";
import { getDashboardTrendingTickers } from "../services/dashboard/trendingTickers.service.js";
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
 * Public, read-only, database-only. One consolidated list for the Dashboard's
 * moving ticker tape: the most-mentioned tickers in stored Reddit content (the
 * worker's latest ranking) joined with the latest stored delayed quotes.
 *
 * There is NO mock fallback on either side. A symbol without a real stored
 * quote ships with `quote: null`; a missing or unverifiable ranking returns an
 * empty list with `meta.status = "empty"`; an old ranking is served with
 * `meta.status = "stale"` and its `snapshotAt`. A database failure is a 500, so
 * the client shows an error rather than a plausible-looking tape.
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

const TRENDING_DEFAULT_LIMIT = 5;

/**
 * GET /api/dashboard/trending-tickers?timeframe=1h|6h|24h|7d&limit=5
 *
 * Public, read-only, database-only. The Dashboard's Trending Tickers table: the
 * SAME worker ranking the ticker strip serves (most-mentioned tickers in stored
 * Reddit content), with a competition rank, the company name from the listing
 * directories the catalog job imports, and the latest stored delayed quote.
 *
 * No curated symbol list and no fallback: an unknown name is `companyName:
 * null`, a missing price is `quote: null`, no ranking is `meta.status =
 * "empty"`, an old one is `"stale"` with its `snapshotAt`. A database failure
 * is a 500, so the panel shows an error instead of a plausible table.
 */
dashboardRouter.get(
  "/dashboard/trending-tickers",
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
      : TRENDING_DEFAULT_LIMIT;

    const result = await getDashboardTrendingTickers({ timeframe: rawTimeframe, limit });
    return ok(res, result);
  }),
);

/**
 * GET /api/dashboard/market-pulse?timeframe=1h|6h|24h|7d   (default 24h)
 *
 * Public, read-only, database-only. The newest Market Pulse snapshot the worker
 * (jobs/refreshMarketPulse.job.ts) computed from stored Reddit ticker mentions:
 * the 0..100 score, every count it was derived from, the formula version, and
 * a label/description built from those counts.
 *
 * No fallback of any kind. `status` says what the numbers are worth:
 *   ok · stale (old snapshot, served with its snapshotAt) · insufficient (too
 *   few classified mentions — score null) · empty (never computed).
 * A database failure is a 500, so the panel shows an error instead of a needle.
 */
dashboardRouter.get(
  "/dashboard/market-pulse",
  asyncHandler(async (req, res) => {
    const rawTimeframe = req.query.timeframe ?? "24h";
    if (!isPulseTimeframe(rawTimeframe)) {
      return fail(
        res,
        `Unsupported timeframe. Use one of: ${PULSE_TIMEFRAMES.join(", ")}.`,
        400,
      );
    }

    const result = await getDashboardMarketPulse({ timeframe: rawTimeframe });
    return ok(res, result);
  }),
);
