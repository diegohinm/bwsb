import { Router } from "express";

import { asyncHandler } from "../lib/response.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  readLeaderboard,
  readMyPerformance,
  readSummary,
  readTickerRanking,
} from "../services/arena/arenaRead.service.js";
import {
  ARENA_PERIODS,
  isArenaPeriod,
  type ArenaPeriod,
  type ArenaScope,
} from "../services/arena/arenaPeriods.js";

/**
 * ARENA — four PUBLIC read-only routes and one private one.
 *
 * The public routes carry no auth middleware by design: the rankings are the
 * product's shop window and must render for a logged-out visitor. What is
 * protected is personal — `/arena/me` needs a session, and every mutation lives
 * behind the existing personal routes.
 *
 * All five read worker-written snapshots through Prisma. None can reach a
 * provider, so a visitor cannot cost an upstream request.
 */

export const arenaRouter = Router();

const MAX_LIMIT = 100;

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** An unsupported period falls back to daily rather than 400-ing a public page. */
function readPeriod(raw: unknown): ArenaPeriod {
  const value = firstString(raw);
  return isArenaPeriod(value) ? value : "daily";
}

function pagination(query: Record<string, unknown>, defaultLimit: number) {
  const page = Math.max(1, Number(firstString(query.page) ?? 1) || 1);
  const rawLimit = Number(firstString(query.limit) ?? defaultLimit) || defaultLimit;
  return { page, limit: Math.min(MAX_LIMIT, Math.max(1, rawLimit)) };
}

/** Shared handler for the two ticker tables — they differ only in scope. */
function tickerRoute(scope: ArenaScope) {
  return asyncHandler(async (req, res) => {
    const period = readPeriod(req.query.period);
    const { limit } = pagination(req.query, 10);
    const { rows, meta } = await readTickerRanking(scope, period, limit);
    return res.json({ data: rows, meta });
  });
}

/**
 * GET /api/arena/tickers/wsb?period=daily&limit=10
 * Only r/wallstreetbets — never blended with the aggregate table.
 */
arenaRouter.get("/arena/tickers/wsb", tickerRoute("wallstreetbets"));

/** GET /api/arena/tickers/all — every tracked investing community, aggregated. */
arenaRouter.get("/arena/tickers/all", tickerRoute("all"));

/**
 * GET /api/arena/leaderboard?period=daily&page=1&limit=20
 *
 * Public. Returns only snapshots whose publication delay has elapsed, and only
 * public profile fields. `meta` reports how many users are registered versus
 * actually rankable, so the page can be honest about the difference instead of
 * scoring inactive accounts at 0%.
 */
arenaRouter.get(
  "/arena/leaderboard",
  asyncHandler(async (req, res) => {
    const period = readPeriod(req.query.period);
    const { page, limit } = pagination(req.query, 20);
    const { rows, meta } = await readLeaderboard(period, page, limit);
    return res.json({ data: rows, meta });
  }),
);

/** GET /api/arena/summary?period=daily — the overview cards. Public. */
arenaRouter.get(
  "/arena/summary",
  asyncHandler(async (req, res) => {
    const period = readPeriod(req.query.period);
    const { data, meta } = await readSummary(period);
    return res.json({ data, meta });
  }),
);

/**
 * GET /api/arena/me?period=daily — the caller's own Arena standing.
 *
 * The only private route here: 401 without a session, so personal rank and
 * personal P/L cannot be read by asking directly.
 */
arenaRouter.get(
  "/arena/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const period = readPeriod(req.query.period);
    const data = await readMyPerformance(req.user!.id, period);
    if (!data) {
      return res.json({
        data: null,
        meta: { period, ranked: false, periods: ARENA_PERIODS },
      });
    }
    return res.json({ data, meta: { period, ranked: true, periods: ARENA_PERIODS } });
  }),
);
