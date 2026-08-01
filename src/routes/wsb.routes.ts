import { Router } from "express";

import { fail, asyncHandler } from "../lib/response.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  getBanbetActivity,
  getBanbetBoard,
  getBanbetsForUser,
  getWsbCryptoPositions,
  getWsbOptionPositions,
  getWsbPortfolioSummary,
  getWsbStockPositions,
} from "../services/wsb/wsbRead.service.js";
import {
  BANBET_SECTIONS,
  BANBET_SORTS,
  DURATION_FILTERS,
  OPTION_SORTS,
  WSB_TIMEFRAMES,
  isWsbTimeframe,
  type BanbetSection,
  type BanbetSide,
  type DurationFilter,
  type OptionSort,
} from "../services/wsb/wsb.types.js";

/**
 * WSB WORKSPACE — public, read-only.
 *
 * Every route here reads worker-written database snapshots. None of them can
 * reach Mindcase, Reddit or any other upstream: the read service they call
 * touches Prisma only, so a user changing a filter costs a query, never an
 * ingestion job.
 *
 * `/wsb/banbets/me` is the single private route — it needs a session and
 * returns 401 otherwise. Everything else is viewable logged out.
 */

export const wsbRouter = Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Clamp a page/limit pair so a hand-written query can't ask for the world. */
function pagination(query: Record<string, unknown>): { page: number; limit: number } {
  const page = Math.max(1, Number(firstString(query.page) ?? 1) || 1);
  const rawLimit = Number(firstString(query.limit) ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  return { page, limit: Math.min(MAX_LIMIT, Math.max(1, rawLimit)) };
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Timeframe or a 400 — an unsupported window is a client error, not a default. */
function readTimeframe(raw: unknown) {
  const value = firstString(raw) ?? "24h";
  return isWsbTimeframe(value) ? value : null;
}

const BAD_TIMEFRAME = `Unsupported timeframe. Use one of: ${WSB_TIMEFRAMES.join(", ")}.`;

// ── Portfolio ────────────────────────────────────────────────────────────────

/**
 * GET /api/wsb/portfolio/summary?timeframe=24h|7d|30d
 *
 * Traders, bullish share, exposure, allocation and the duration breakdown, as
 * stored by the last successful worker run. `data` is null when no snapshot
 * exists yet — an empty portfolio, never invented numbers.
 */
wsbRouter.get(
  "/wsb/portfolio/summary",
  asyncHandler(async (req, res) => {
    const timeframe = readTimeframe(req.query.timeframe);
    if (!timeframe) return fail(res, BAD_TIMEFRAME, 400);

    const { data, meta } = await getWsbPortfolioSummary(timeframe);
    return res.json({ data, meta });
  }),
);

/**
 * GET /api/wsb/portfolio/options
 *   ?timeframe=&duration=all|0dte|weekly|swing|long&page=&limit=&sort=
 *
 * The duration filter is applied in SQL against the bucket the worker assigned
 * at snapshot time — see services/wsb/optionDuration.service.ts.
 */
wsbRouter.get(
  "/wsb/portfolio/options",
  asyncHandler(async (req, res) => {
    const timeframe = readTimeframe(req.query.timeframe);
    if (!timeframe) return fail(res, BAD_TIMEFRAME, 400);

    const { page, limit } = pagination(req.query);
    const duration = oneOf<DurationFilter>(
      firstString(req.query.duration),
      DURATION_FILTERS,
      "all",
    );
    const sort = oneOf<OptionSort>(firstString(req.query.sort), OPTION_SORTS, "value");

    const { data, meta } = await getWsbOptionPositions({ timeframe, duration, page, limit, sort });
    return res.json({ data, meta });
  }),
);

/** GET /api/wsb/portfolio/stocks?timeframe=&page=&limit= */
wsbRouter.get(
  "/wsb/portfolio/stocks",
  asyncHandler(async (req, res) => {
    const timeframe = readTimeframe(req.query.timeframe);
    if (!timeframe) return fail(res, BAD_TIMEFRAME, 400);

    const { page, limit } = pagination(req.query);
    const { data, meta } = await getWsbStockPositions({ timeframe, page, limit });
    return res.json({ data, meta });
  }),
);

/**
 * GET /api/wsb/portfolio/crypto?timeframe=&page=&limit=
 *
 * Returns an empty page until the extraction pipeline can identify a crypto
 * holding with enough confidence. That empty page is the honest answer.
 */
wsbRouter.get(
  "/wsb/portfolio/crypto",
  asyncHandler(async (req, res) => {
    const timeframe = readTimeframe(req.query.timeframe);
    if (!timeframe) return fail(res, BAD_TIMEFRAME, 400);

    const { page, limit } = pagination(req.query);
    const { data, meta } = await getWsbCryptoPositions({ timeframe, page, limit });
    return res.json({ data, meta });
  }),
);

// ── Banbets ──────────────────────────────────────────────────────────────────

/**
 * GET /api/wsb/banbets/activity
 *   ?section=all|resolved|expiring&page=&limit=&ticker=&side=bull|bear&sort=
 *
 * `expiringSoon` is ordered by nearest deadline in the query itself, so the
 * ordering cannot drift with client-side sorting.
 */
wsbRouter.get(
  "/wsb/banbets/activity",
  asyncHandler(async (req, res) => {
    const { page, limit } = pagination(req.query);
    const section = oneOf<BanbetSection>(
      firstString(req.query.section),
      BANBET_SECTIONS,
      "all",
    );
    // Accepted and validated for contract stability; ordering is fixed per
    // section (resolved = newest, expiring = soonest), so it is not yet a knob.
    oneOf(firstString(req.query.sort), BANBET_SORTS, "recent");

    const sideRaw = firstString(req.query.side);
    const side: BanbetSide | undefined =
      sideRaw === "bull" || sideRaw === "bear" ? sideRaw : undefined;
    const ticker = firstString(req.query.ticker)?.trim().toUpperCase() || undefined;

    const { data, meta } = await getBanbetActivity({ section, page, limit, ticker, side });
    return res.json({ data, meta });
  }),
);

/**
 * GET /api/wsb/banbets/me — the signed-in user's own banbets.
 *
 * The only private route in this file: 401 without a session, so a logged-out
 * client cannot see personal data even by asking for it directly.
 */
wsbRouter.get(
  "/wsb/banbets/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { limit } = pagination(req.query);
    const { data, meta } = await getBanbetsForUser(req.user!.id, limit);
    return res.json({ data, meta });
  }),
);

/**
 * GET /api/wsb/banbets/board — standings across resolved banbets.
 *
 * Public and read-only. Empty until banbets have resolved, which the client
 * renders as "no standings yet" rather than as a fake ranking.
 */
wsbRouter.get(
  "/wsb/banbets/board",
  asyncHandler(async (req, res) => {
    const { limit } = pagination(req.query);
    const { data, meta } = await getBanbetBoard(limit);
    return res.json({ data, meta });
  }),
);
