import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import {
  getSubredditPulse,
  getTickerSocialFeed,
  getSocialProviderStatus,
  getIngestionStatus,
  isPulseTimeframe,
  PULSE_TIMEFRAMES,
} from "../services/social/index.js";
import type {
  SocialContentType,
  SocialFeedSort,
  SocialSentiment,
} from "../services/social/index.js";
import { TRACKED_SUBREDDITS } from "../services/social/subreddits.js";

export const pulseRouter = Router();

const CONTENT_TYPES: SocialContentType[] = [
  "post",
  "comment",
  "screenshot",
  "link",
  "unknown",
];
const SENTIMENTS: SocialSentiment[] = ["positive", "neutral", "negative"];
const SORTS: SocialFeedSort[] = ["newest", "top", "most_comments", "highest_confidence"];

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * GET /api/pulse/subreddits?timeframe=1h|6h|24h|7d&q=
 *
 * Public, read-only. Normalized cross-subreddit trend data from the configured
 * social data provider, with graceful mock fallback. Never exposes provider
 * secrets. `data.isMock` + `data.warning` tell the client when to badge demo
 * data.
 */
pulseRouter.get(
  "/pulse/subreddits",
  asyncHandler(async (req, res) => {
    const raw = req.query.timeframe ?? "24h";
    if (!isPulseTimeframe(raw)) {
      return fail(
        res,
        `Unsupported timeframe. Use one of: ${PULSE_TIMEFRAMES.join(", ")}.`,
        400,
      );
    }
    const q = firstString(req.query.q)?.trim() || undefined;
    const data = await getSubredditPulse({ timeframe: raw, q });
    return ok(res, data);
  }),
);

/** GET /api/pulse/provider — active provider status (no secrets). */
pulseRouter.get(
  "/pulse/provider",
  asyncHandler(async (_req, res) => ok(res, await getSocialProviderStatus())),
);

/**
 * GET /api/tickers/:ticker/social
 *   ?timeframe=1h|6h|24h|7d
 *   &q= &type=all|post|comment|screenshot|link
 *   &sentiment=all|positive|neutral|negative
 *   &subreddit=all|wallstreetbets|... &sort=newest|top|most_comments|highest_confidence
 *
 * Public, read-only. Latest posts/comments for a ticker, classified server-side.
 */
pulseRouter.get(
  "/tickers/:ticker/social",
  asyncHandler(async (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    const raw = req.query.timeframe ?? "24h";
    if (!isPulseTimeframe(raw)) {
      return fail(
        res,
        `Unsupported timeframe. Use one of: ${PULSE_TIMEFRAMES.join(", ")}.`,
        400,
      );
    }

    const typeRaw = firstString(req.query.type);
    const sentimentRaw = firstString(req.query.sentiment);
    const sortRaw = firstString(req.query.sort);

    const type =
      typeRaw && (CONTENT_TYPES as string[]).includes(typeRaw)
        ? (typeRaw as SocialContentType)
        : "all";
    const sentiment =
      sentimentRaw && (SENTIMENTS as string[]).includes(sentimentRaw)
        ? (sentimentRaw as SocialSentiment)
        : "all";
    const sort =
      sortRaw && (SORTS as string[]).includes(sortRaw)
        ? (sortRaw as SocialFeedSort)
        : "newest";
    const subreddit = firstString(req.query.subreddit) || "all";
    const q = firstString(req.query.q)?.trim() || undefined;

    const data = await getTickerSocialFeed({
      ticker,
      timeframe: raw,
      q,
      type,
      sentiment,
      subreddit,
      sort,
    });
    return ok(res, data);
  }),
);

/**
 * GET /api/ingestion/status — provider health + diagnostics for admin/status
 * surfaces. Never exposes API keys.
 */
pulseRouter.get(
  "/ingestion/status",
  asyncHandler(async (_req, res) => ok(res, await getIngestionStatus())),
);

/** GET /api/pulse/meta — tracked subreddits + supported timeframes. */
pulseRouter.get("/pulse/meta", (_req, res) => {
  ok(res, { timeframes: PULSE_TIMEFRAMES, trackedSubreddits: TRACKED_SUBREDDITS });
});
