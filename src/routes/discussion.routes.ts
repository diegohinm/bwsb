import { Router } from "express";

import { asyncHandler, fail } from "../lib/response.js";
import { parseSubredditFilter } from "../services/social/subreddits.js";
import { PULSE_TIMEFRAME_MS, isPulseTimeframe } from "../services/social/socialData.types.js";
import {
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
  isContentType,
  isDiscussionSort,
  isSortDirection,
  isSortField,
  type SortDirection,
  type SortField,
  isSentimentFilter,
  readDiscussion,
  readGlobalDiscussion,
  type ContentType,
  type DiscussionSort,
  type SentimentFilter,
} from "../services/discussion/discussionRead.service.js";
import { discussionHub, GLOBAL_SCOPE } from "../realtime/discussionHub.js";
import { discussionSource } from "../realtime/discussionSource.js";
import {
  DAILY_DISCUSSION_SUBREDDIT,
  isDiscussionThreadType,
  type DiscussionThreadType,
} from "../services/social/dailyDiscussion.service.js";
import {
  isDiscussionRange,
  readDiscussionSummary,
} from "../services/discussion/discussionSummary.service.js";
import type { DiscussionFrame } from "../realtime/discussionEvents.js";

/**
 * DISCUSSION — the live Reddit feed, globally and per ticker.
 *
 * Five PUBLIC routes, all read-only:
 *
 *   GET /api/discussion                         the global feed, with filters
 *   GET /api/discussion/stream                  SSE for the global feed
 *   GET /api/tickers/:symbol/discussion         one ticker's snapshot
 *   GET /api/tickers/:symbol/discussion/stream  SSE for one ticker
 *   GET /api/discussion/status                  what the status bar reports
 *
 * Snapshots read the database; the streams carry only deltas. None of them can
 * reach a provider, so a room full of readers costs the same upstream as an
 * empty one.
 */

export const discussionRouter = Router();

const SYMBOL = /^[A-Z][A-Z.\-]{0,9}$/;
/** SSE keep-alive: without it a proxy will drop an idle stream. */
const SSE_HEARTBEAT_MS = 25_000;

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function readSymbol(raw: unknown): string | null {
  const symbol = String(raw ?? "").trim().toUpperCase();
  return SYMBOL.test(symbol) ? symbol : null;
}

/** An unsupported window falls back to 24h rather than 400-ing a public page. */
function readSince(raw: unknown): Date | undefined {
  const value = firstString(raw);
  if (!value || value === "all") return undefined;
  if (!isPulseTimeframe(value)) return new Date(Date.now() - PULSE_TIMEFRAME_MS["24h"]);
  return new Date(Date.now() - PULSE_TIMEFRAME_MS[value]);
}

function readSort(raw: unknown): DiscussionSort {
  const value = firstString(raw);
  return isDiscussionSort(value) ? value : "newest";
}

function readLimit(raw: unknown): number {
  const value = Number(firstString(raw) ?? DEFAULT_FEED_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_FEED_LIMIT;
  return Math.min(MAX_FEED_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * The global feed's date-range presets. A superset of PULSE_TIMEFRAMES (adds
 * `30d`), kept local because the Discussion feed owns this control and Pulse
 * does not offer a month view.
 */
const DISCUSSION_RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * A preset range resolved to a lower bound on `postedAt` (now − range).
 *
 * Returns undefined for an absent or unrecognized value rather than 400-ing a
 * public page a hand-edited URL can reach — the feed then simply applies no
 * lower bound. An explicit `from` always takes precedence over this.
 */
function readRangeFrom(raw: unknown, now = Date.now()): Date | undefined {
  const value = firstString(raw);
  const ms = value ? DISCUSSION_RANGE_MS[value.trim().toLowerCase()] : undefined;
  return ms ? new Date(now - ms) : undefined;
}

/** A `YYYY-MM-DD` bound, or undefined when absent/unparseable. */
function readDate(raw: unknown, endOfDay = false): Date | undefined {
  const value = firstString(raw);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return undefined;
  // The `to` bound is inclusive of the whole day, which is what a date picker
  // labelled "To" means to the person using it.
  const date = new Date(`${value.trim()}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Accepts `all | post | comment | daily_discussion`.
 *
 * Case- and separator-insensitive, so `DAILY_DISCUSSION`, `daily-discussion`
 * and `dailyDiscussion` all resolve — the value travels in a shareable URL that
 * people retype, and the alternative is a silent fallback to "all" that looks
 * like the filter simply does not work.
 */
function readContentType(raw: unknown): ContentType {
  const value = firstString(raw);
  if (!value) return "all";
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  const canonical = normalized === "dailydiscussion" ? "daily_discussion" : normalized;
  return isContentType(canonical) ? canonical : "all";
}

/**
 * Which recurring thread. `daily` | `tomorrow` | `weekend`, any casing.
 * Anything unrecognized falls back to the everyday thread rather than 400-ing.
 */
function readDiscussionType(raw: unknown): DiscussionThreadType {
  const value = firstString(raw)?.trim().toUpperCase();
  return isDiscussionThreadType(value) ? value : "DAILY";
}

/**
 * THE BUSINESS RULE, ENFORCED SERVER-SIDE.
 *
 * Daily Discussion exists only for r/wallstreetbets. A request that asks for it
 * while naming other communities is not honoured half-way — the scope is
 * replaced, not intersected, because intersecting would silently return an
 * empty feed and look like "no data" rather than "invalid combination".
 *
 * The frontend forces the same thing, but the frontend is not trusted: this
 * endpoint is public and can be called directly.
 */
function enforceDailyScope(
  contentType: ContentType,
  requested: string[] | undefined,
): string[] | undefined {
  if (contentType !== "daily_discussion") return requested;
  return [DAILY_DISCUSSION_SUBREDDIT];
}

function readSortField(raw: unknown): SortField | undefined {
  const value = firstString(raw);
  return isSortField(value) ? value : undefined;
}

function readSortDirection(raw: unknown): SortDirection | undefined {
  const value = firstString(raw)?.toLowerCase();
  return isSortDirection(value) ? value : undefined;
}

function readSentiment(raw: unknown): SentimentFilter {
  const value = firstString(raw);
  return isSentimentFilter(value) ? value : "all";
}

/**
 * GET /api/discussion — THE GLOBAL FEED. Public.
 *
 * ?subreddits=a,b&type=all|post|comment|daily_discussion
 * &sentiment=all|bullish|neutral|bearish
 * &from=YYYY-MM-DD&to=YYYY-MM-DD&sort=newest|upvotes|comments&q=&limit=60
 *
 * Every filter fails SAFE: an unrecognized value falls back to "all" rather
 * than 400-ing a public page a hand-edited URL can reach.
 */
discussionRouter.get(
  "/discussion",
  asyncHandler(async (req, res) => {
    // An explicit `from` (custom range) wins over a `range` preset; when only a
    // preset is given it becomes the lower bound.
    const explicitFrom = readDate(req.query.from);
    const contentType = readContentType(req.query.type);
    const { items, meta } = await readGlobalDiscussion({
      // Daily Discussion is r/wallstreetbets only, and that is enforced HERE —
      // a direct call naming other communities does not get a half-honoured
      // scope.
      subreddits: enforceDailyScope(
        contentType,
        parseSubredditFilter(firstString(req.query.subreddits)),
      ),
      contentType,
      discussionType: readDiscussionType(req.query.discussionType),
      sentiment: readSentiment(req.query.sentiment),
      from: explicitFrom ?? readRangeFrom(req.query.range),
      to: readDate(req.query.to, true),
      search: firstString(req.query.q) ?? firstString(req.query.search),
      sort: readSort(req.query.sort),
      // Whitelisted column + direction. Anything else falls back to
      // newest-first rather than reaching the query builder.
      sortField: readSortField(req.query.sort),
      sortDirection: readSortDirection(req.query.direction),
      limit: readLimit(req.query.limit),
    });

    return res.json({
      data: items,
      meta: {
        ...meta,
        stream: {
          websocketPath: "/ws/discussion?scope=all",
          ssePath: "/api/discussion/stream",
          sourceMode: discussionSource.mode,
          pollIntervalMs: discussionSource.intervalMs,
        },
      },
    });
  }),
);

/**
 * GET /api/discussion/summary — aggregates for the CURRENTLY SELECTED range.
 *
 * ?range=1h|6h|24h|7d|30d|custom&from=&to=&subreddits=&type=&sentiment=&q=
 *
 * Takes the SAME filters as the feed so the two can never describe different
 * datasets, and every figure is computed by Postgres over the whole window —
 * not by counting the rows a page happened to fetch.
 */
discussionRouter.get(
  "/discussion/summary",
  asyncHandler(async (req, res) => {
    const rawRange = firstString(req.query.range);
    const range = isDiscussionRange(rawRange) ? rawRange : "24h";
    const from = readDate(req.query.from);
    const to = readDate(req.query.to, true);

    const summary = await readDiscussionSummary({
      // A custom range needs both ends; with only one it falls back to 24h
      // rather than inventing the other.
      range: range === "custom" && (!from || !to) ? "24h" : range,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      subreddits: parseSubredditFilter(firstString(req.query.subreddits)),
      contentType: readContentType(req.query.type),
      sentiment: readSentiment(req.query.sentiment),
      search: firstString(req.query.q) ?? firstString(req.query.search),
    });

    return res.json({ data: summary });
  }),
);

/**
 * GET /api/discussion/stream — SSE for the global feed.
 *
 * The WebSocket's fallback, fed by the SAME hub, so both transports deliver
 * byte-identical events.
 */
discussionRouter.get(
  "/discussion/stream",
  asyncHandler(async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const write = (frame: DiscussionFrame) => {
      res.write(`data: ${JSON.stringify(frame)}

`);
    };

    const unsubscribe = discussionHub.subscribe(GLOBAL_SCOPE, write);
    discussionSource.start();

    write({
      kind: "hello",
      ticker: GLOBAL_SCOPE,
      transport: "sse",
      sourceMode: discussionSource.mode,
      pollIntervalMs: discussionSource.intervalMs,
    });

    const heartbeat = setInterval(() => {
      write({ kind: "heartbeat", at: new Date().toISOString() });
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });

    return undefined;
  }),
);

/**
 * GET /api/tickers/:symbol/discussion
 * ?timeframe=24h&subreddits=a,b&search=&sort=newest|upvotes|comments&limit=60
 */
discussionRouter.get(
  "/tickers/:symbol/discussion",
  asyncHandler(async (req, res) => {
    const symbol = readSymbol(req.params.symbol);
    if (!symbol) return fail(res, "Invalid ticker symbol", 400);

    const snapshot = await readDiscussion({
      symbol,
      subreddits: parseSubredditFilter(firstString(req.query.subreddits)),
      since: readSince(req.query.timeframe),
      search: firstString(req.query.search),
      sort: readSort(req.query.sort),
      limit: readLimit(req.query.limit),
    });

    return res.json({
      data: { posts: snapshot.posts, comments: snapshot.comments },
      meta: {
        ...snapshot.meta,
        stream: {
          websocketPath: "/ws/discussion",
          ssePath: `/api/tickers/${symbol}/discussion/stream`,
          sourceMode: discussionSource.mode,
          pollIntervalMs: discussionSource.intervalMs,
        },
      },
    });
  }),
);

/**
 * GET /api/tickers/:symbol/discussion/stream — Server-Sent Events.
 *
 * The automatic fallback for a client whose WebSocket cannot connect (a proxy
 * that strips Upgrade, a corporate filter). It is fed by the SAME hub, so the
 * two transports deliver byte-identical events and the UI does not care which
 * one it got them from.
 */
discussionRouter.get(
  "/tickers/:symbol/discussion/stream",
  asyncHandler(async (req, res) => {
    const symbol = readSymbol(req.params.symbol);
    if (!symbol) return fail(res, "Invalid ticker symbol", 400);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and friends buffer by default, which would defeat the point.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const write = (frame: DiscussionFrame) => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    const unsubscribe = discussionHub.subscribe(symbol, write);
    discussionSource.start();

    write({
      kind: "hello",
      ticker: symbol,
      transport: "sse",
      sourceMode: discussionSource.mode,
      pollIntervalMs: discussionSource.intervalMs,
    });

    const heartbeat = setInterval(() => {
      write({ kind: "heartbeat", at: new Date().toISOString() });
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });

    // Held open deliberately — asyncHandler must not treat this as unfinished.
    return undefined;
  }),
);

/** GET /api/discussion/status — what the status bar reports. Public, no secrets. */
discussionRouter.get(
  "/discussion/status",
  asyncHandler(async (_req, res) =>
    res.json({
      data: {
        sourceMode: discussionSource.mode,
        pollIntervalMs: discussionSource.intervalMs,
        websocketPath: "/ws/discussion",
        ...discussionHub.stats(),
      },
    }),
  ),
);
