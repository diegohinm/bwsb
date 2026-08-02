import { Router } from "express";

import { asyncHandler, fail } from "../lib/response.js";
import { parseSubredditFilter } from "../services/social/subreddits.js";
import { PULSE_TIMEFRAME_MS, isPulseTimeframe } from "../services/social/socialData.types.js";
import {
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
  isDiscussionSort,
  readDiscussion,
  type DiscussionSort,
} from "../services/discussion/discussionRead.service.js";
import { discussionHub } from "../realtime/discussionHub.js";
import { discussionSource } from "../realtime/discussionSource.js";
import type { DiscussionFrame } from "../realtime/discussionEvents.js";

/**
 * DISCUSSION — the ticker's live Reddit feed.
 *
 * Three PUBLIC routes, all read-only:
 *
 *   GET /api/tickers/:symbol/discussion         the snapshot the tab loads with
 *   GET /api/tickers/:symbol/discussion/stream  SSE, the WebSocket's fallback
 *   GET /api/discussion/status                  what the status bar reports
 *
 * The snapshot reads the database; the stream carries only deltas. Neither can
 * reach a provider, so a room full of people watching MSFT costs the same
 * upstream as nobody watching it.
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
