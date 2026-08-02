import { Router } from "express";

import { asyncHandler, fail } from "../lib/response.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { prisma } from "../lib/prisma.js";
import { catalogTicker } from "../config/tickerCatalog.js";
import { parseSubredditFilter } from "../services/social/subreddits.js";
import {
  DEFAULT_PREFERENCES,
  readPersonalCalendar,
  readPreferences,
  readPublicCalendar,
  readSymbolCalendar,
  writePreferences,
  type CalendarPreferences,
} from "../services/calendar/calendarRead.service.js";
import { getEarningsDataProvider } from "../services/calendar/earningsDataProvider.factory.js";
import {
  CALENDAR_VIEWS,
  DEFAULT_TRENDING_LIMIT,
  MAX_PERSONAL_TICKERS,
  MAX_RANGE_DAYS,
  MAX_TRENDING_LIMIT,
  defaultRange,
  isCalendarView,
  isEarningsStatus,
  isEarningsTiming,
  isSocialTimeframe,
  parseDateKey,
  type EarningsStatus,
  type EarningsTiming,
  type SocialTimeframe,
} from "../services/calendar/calendarVocabulary.js";

/**
 * EARNINGS CALENDAR — two PUBLIC routes and three private ones.
 *
 * The public pair carries no auth middleware by design: the calendar of what
 * Reddit is watching is browsable by anyone, and only personalization needs an
 * account. The private trio is guarded here, server-side — hiding the controls
 * in the frontend is not a permission model, so `/calendar/me/earnings` and the
 * preference endpoints 401 regardless of what the UI shows.
 *
 * Every route reads Postgres. None of them can call the earnings provider.
 */

export const calendarRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * The requested window, clamped.
 *
 * Bad input fails SAFE rather than 400-ing a public page: an unparseable date
 * falls back to the default month, and a range wider than the cap is truncated
 * so one hand-edited URL cannot scan the whole table.
 */
function readRange(query: Record<string, unknown>): { start: Date; end: Date } {
  const fallback = defaultRange();
  const start = parseDateKey(firstString(query.start)) ?? fallback.start;
  let end = parseDateKey(firstString(query.end)) ?? fallback.end;

  if (end.getTime() < start.getTime()) end = new Date(start.getTime() + 30 * DAY_MS);
  const maxEnd = new Date(start.getTime() + MAX_RANGE_DAYS * DAY_MS);
  if (end.getTime() > maxEnd.getTime()) end = maxEnd;

  return { start, end };
}

function readStatus(raw: unknown): EarningsStatus | "all" {
  const value = firstString(raw);
  return isEarningsStatus(value) ? value : "all";
}

function readTiming(raw: unknown): EarningsTiming | "all" {
  const value = firstString(raw);
  return isEarningsTiming(value) ? value : "all";
}

function readSocialTimeframe(raw: unknown): SocialTimeframe {
  const value = firstString(raw);
  return isSocialTimeframe(value) ? value : "7d";
}

function readLimitTickers(raw: unknown): number {
  const value = Number(firstString(raw) ?? DEFAULT_TRENDING_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TRENDING_LIMIT;
  return Math.min(MAX_TRENDING_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * GET /api/calendar/earnings — the PUBLIC, Reddit-trending calendar.
 *
 * ?start=&end=&socialTimeframe=24h|7d|30d&subreddits=a,b&status=&timing=&limitTickers=
 */
calendarRouter.get(
  "/calendar/earnings",
  asyncHandler(async (req, res) => {
    const { start, end } = readRange(req.query as Record<string, unknown>);
    const { data, meta } = await readPublicCalendar({
      start,
      end,
      socialTimeframe: readSocialTimeframe(req.query.socialTimeframe),
      subreddits: parseSubredditFilter(firstString(req.query.subreddits)),
      limitTickers: readLimitTickers(req.query.limitTickers),
      filters: { status: readStatus(req.query.status), timing: readTiming(req.query.timing) },
    });
    return res.json({ data, meta });
  }),
);

/** GET /api/calendar/earnings/:symbol — one ticker's events. Public. */
calendarRouter.get(
  "/calendar/earnings/:symbol",
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z.\-]{0,9}$/.test(symbol)) {
      return fail(res, "Invalid ticker symbol", 400);
    }
    // A single ticker gets a wider default window than the grid: the detail
    // panel wants the previous report as well as the next one.
    const fallbackStart = new Date(Date.now() - 400 * DAY_MS);
    const fallbackEnd = new Date(Date.now() + 400 * DAY_MS);
    const start = parseDateKey(firstString(req.query.start)) ?? fallbackStart;
    const end = parseDateKey(firstString(req.query.end)) ?? fallbackEnd;

    const { data, meta } = await readSymbolCalendar(symbol, { start, end });
    return res.json({ data, meta });
  }),
);

/** GET /api/calendar/status — which earnings source is configured. Public, no secrets. */
calendarRouter.get(
  "/calendar/status",
  asyncHandler(async (_req, res) => {
    const status = await getEarningsDataProvider().getStatus();
    return res.json({ data: status });
  }),
);

/**
 * GET /api/calendar/me/earnings — the caller's personalized calendar.
 * Private: 401 without a session.
 */
calendarRouter.get(
  "/calendar/me/earnings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { start, end } = readRange(req.query as Record<string, unknown>);
    const { data, meta } = await readPersonalCalendar(req.user!.id, {
      start,
      end,
      filters: { status: readStatus(req.query.status), timing: readTiming(req.query.timing) },
    });
    return res.json({ data, meta });
  }),
);

/** GET /api/calendar/preferences — private. */
calendarRouter.get(
  "/calendar/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await readPreferences(req.user!.id);
    return res.json({
      data,
      meta: { maxTickers: MAX_PERSONAL_TICKERS, views: CALENDAR_VIEWS },
    });
  }),
);

/**
 * Validate a submitted symbol list against the ticker catalog and the tickers
 * table. Arbitrary strings are rejected rather than stored — an unvalidated
 * "ticker" is a row that can never match an earnings event and a hint that the
 * field is a free-text sink.
 */
async function validateTickers(
  raw: unknown,
): Promise<{ tickers: string[]; rejected: string[] } | { error: string }> {
  if (raw === undefined) return { tickers: [], rejected: [] };
  if (!Array.isArray(raw)) return { error: "selectedTickers must be an array of symbols" };

  const wanted: string[] = [];
  // Malformed entries are collected, not dropped in silence: a user who typed
  // "NOT A TICKER" must be told it did not stick, not left to discover it.
  const malformed: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const symbol = item.trim().toUpperCase();
    if (!symbol) continue;
    if (!/^[A-Z][A-Z.\-]{0,9}$/.test(symbol)) {
      if (!malformed.includes(symbol)) malformed.push(symbol);
      continue;
    }
    if (!wanted.includes(symbol)) wanted.push(symbol);
  }
  if (wanted.length > MAX_PERSONAL_TICKERS) {
    return { error: `At most ${MAX_PERSONAL_TICKERS} tickers can be selected` };
  }
  if (wanted.length === 0) return { tickers: [], rejected: malformed };

  const known = new Set(
    (
      await prisma.tickers.findMany({
        where: { ticker: { in: wanted } },
        select: { ticker: true },
      })
    ).map((r) => r.ticker.toUpperCase()),
  );
  // The catalog backfills well-known symbols when the tickers table is sparse,
  // exactly as the search endpoint does.
  for (const symbol of wanted) {
    if (!known.has(symbol) && catalogTicker(symbol)) known.add(symbol);
  }

  return {
    tickers: wanted.filter((s) => known.has(s)),
    rejected: [...malformed, ...wanted.filter((s) => !known.has(s))],
  };
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** PUT /api/calendar/preferences — private. Replaces the caller's settings. */
calendarRouter.put(
  "/calendar/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = await readPreferences(req.user!.id);

    const validated = await validateTickers(
      body.selectedTickers === undefined ? current.selectedTickers : body.selectedTickers,
    );
    if ("error" in validated) return fail(res, validated.error, 400);

    const defaultView = isCalendarView(body.defaultView)
      ? body.defaultView
      : current.defaultView;

    const next: CalendarPreferences = {
      selectedTickers: validated.tickers,
      includeWatchlist: readBool(body.includeWatchlist, current.includeWatchlist),
      includeVirtualPositions: readBool(
        body.includeVirtualPositions,
        current.includeVirtualPositions,
      ),
      includeTrendingTickers: readBool(
        body.includeTrendingTickers,
        current.includeTrendingTickers,
      ),
      defaultView,
      timezone:
        typeof body.timezone === "string" && body.timezone.trim()
          ? body.timezone.trim()
          : current.timezone,
    };

    const saved = await writePreferences(req.user!.id, next);
    return res.json({
      data: saved,
      // Rejected symbols are reported rather than silently dropped: the user
      // typed something and deserves to know it did not stick.
      meta: { rejected: validated.rejected, maxTickers: MAX_PERSONAL_TICKERS },
    });
  }),
);

/** DELETE /api/calendar/preferences — reset to defaults. Private. */
calendarRouter.delete(
  "/calendar/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const saved = await writePreferences(req.user!.id, { ...DEFAULT_PREFERENCES });
    return res.json({ data: saved, meta: { reset: true } });
  }),
);
