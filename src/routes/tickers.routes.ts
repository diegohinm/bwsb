import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { tickersRepository } from "../repositories/tickers.repository.js";
import { catalogTicker } from "../config/tickerCatalog.js";
import {
  isPulseTimeframe,
  PULSE_TIMEFRAME_MS,
} from "../services/social/socialData.types.js";
import {
  readMetricsMeta,
  readSentiment,
  readTrend,
} from "../repositories/tickerSocialMetrics.repository.js";
import {
  getSeries as getMentionSentimentSeries,
  isMentionRange,
  parseSubredditFilter,
  MENTION_RANGES,
} from "../services/tickers/tickerMentionSentiment.service.js";
import { mentionsRepository } from "../repositories/mentions.repository.js";
import { betsRepository } from "../repositories/bets.repository.js";
import { metricsRepository } from "../repositories/metrics.repository.js";
import { alertsRepository } from "../repositories/alerts.repository.js";
import { marketRepository } from "../repositories/market.repository.js";
import { backtestsRepository } from "../repositories/backtests.repository.js";

export const tickersRouter = Router();

/** The chart stays readable at four series; the API enforces it too. */
const MAX_TREND_SYMBOLS = 4;

/**
 * GET /api/tickers?sort=popular&timeframe=1h|6h|24h|7d&q= — tracked tickers.
 *
 * Default order is the alphabetical catalog, unchanged. `sort=popular` orders by
 * Reddit mentions inside the requested window, read from the newest
 * worker-written trending snapshot FOR THAT TIMEFRAME (the worker stores all
 * four), and adds `mention_count` — null when unmeasured, never a fabricated 0.
 * `q` filters on symbol or company name.
 *
 * Database reads only: no provider is contacted to serve this.
 */
tickersRouter.get(
  "/tickers",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() || undefined : undefined;
    if (req.query.sort !== "popular") {
      return ok(res, await tickersRepository.listAll(q));
    }

    // An unsupported window falls back to the default rather than 400-ing: a
    // stale link should show data, not an error.
    const raw = typeof req.query.timeframe === "string" ? req.query.timeframe : "24h";
    const timeframe = isPulseTimeframe(raw) ? raw : "24h";

    const [{ rows, snapshotAt }, sentiment, metricsMeta] = await Promise.all([
      tickersRepository.listPopular(q, timeframe),
      readSentiment(timeframe),
      readMetricsMeta(),
    ]);

    return res.json({
      // Sentiment is attached per row from the same window the mentions used, so
      // a Feel % bar can never describe a different period than the count beside it.
      data: rows.map((t) => ({
        ...t,
        sentiment: sentiment.get(t.ticker.toUpperCase()) ?? null,
      })),
      meta: {
        timeframe,
        updatedAt: snapshotAt,
        // No snapshot yet → the alphabetical catalog, and we say so.
        ranked: snapshotAt !== null,
        source: metricsMeta?.source ?? null,
        isMock: metricsMeta?.isMock ?? false,
      },
    });
  }),
);

/**
 * GET /api/tickers/mentions-trend?symbols=AAPL,NVDA&timeframe=24h
 *
 * Mention counts over time for up to four symbols, read from the worker's
 * pre-bucketed metrics. Resolution follows the window (1H→5m … 7D→6h) via the
 * shared rule in the metrics repository, so the API and the worker cannot
 * disagree about what a bucket means.
 *
 * Declared BEFORE `/tickers/:ticker` — otherwise Express would match
 * "mentions-trend" as a ticker symbol.
 *
 * Database reads only: toggling a ticker on the chart never reaches a provider.
 */
tickersRouter.get(
  "/tickers/mentions-trend",
  asyncHandler(async (req, res) => {
    const rawTf = typeof req.query.timeframe === "string" ? req.query.timeframe : "24h";
    const timeframe = isPulseTimeframe(rawTf) ? rawTf : "24h";

    const raw = typeof req.query.symbols === "string" ? req.query.symbols : "";
    // Normalize, drop anything not shaped like a symbol, de-dupe, and cap at
    // four — the chart's readability limit is enforced server-side too, so a
    // hand-written URL cannot ask for fifty series.
    const symbols = [
      ...new Set(
        raw
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/.test(s)),
      ),
    ].slice(0, MAX_TREND_SYMBOLS);

    if (symbols.length === 0) {
      return res.json({
        data: [],
        meta: { timeframe, bucket: null, source: null, isMock: false, updatedAt: null },
      });
    }

    const [{ series, bucket, updatedAt }, metricsMeta] = await Promise.all([
      readTrend(symbols, timeframe),
      readMetricsMeta(),
    ]);

    return res.json({
      data: series,
      meta: {
        timeframe,
        bucket,
        source: metricsMeta?.source ?? null,
        isMock: metricsMeta?.isMock ?? false,
        updatedAt,
      },
    });
  }),
);

/** GET /api/tickers/:ticker — single ticker reference row. */
tickersRouter.get(
  "/tickers/:ticker",
  asyncHandler(async (req, res) => {
    const ticker = await tickersRepository.findByTicker(req.params.ticker.toUpperCase());
    if (!ticker) return fail(res, "Ticker not found", 404);
    return ok(res, ticker);
  }),
);

/** GET /api/tickers/:ticker/overview — aggregated ticker detail. */
tickersRouter.get(
  "/tickers/:ticker/overview",
  asyncHandler(async (req, res) => {
    const symbol = req.params.ticker.toUpperCase();

    // Social aggregates honour the workspace's window; everything derived from
    // market data (quote, beta, short interest) is time-independent and ignores
    // it — the social selector must not silently reinterpret a price.
    const rawTf = typeof req.query.timeframe === "string" ? req.query.timeframe : "24h";
    const socialTimeframe = isPulseTimeframe(rawTf) ? rawTf : "24h";
    const socialSince = new Date(
      Date.now() - PULSE_TIMEFRAME_MS[socialTimeframe],
    ).toISOString();

    // Resolve from the DB; fall back to the centralized catalog so well-known
    // symbols render a detail page even when the tickers table is unseeded.
    let ticker = null;
    try {
      ticker = await tickersRepository.findByTicker(symbol);
    } catch (err) {
      console.error(`findByTicker(${symbol}) failed:`, err);
    }
    ticker = ticker ?? catalogTicker(symbol);
    if (!ticker) return fail(res, "Ticker not found", 404);

    // Each aggregate source is best-effort: a slow/failing DB query degrades to
    // an empty section instead of 500-ing (and hanging) the whole page.
    const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p;
      } catch (err) {
        console.error(`Ticker overview sub-query failed for ${symbol}:`, err);
        return fallback;
      }
    };

    const [
      market,
      metrics,
      stanceSplit,
      positioning,
      pump,
      narratives,
      dd,
      daily,
      alerts,
      shortInterest,
      catalysts,
    ] = await Promise.all([
      safe(marketRepository.latestSnapshot(symbol), null),
      safe(metricsRepository.latest5mForTicker(symbol), null),
      safe(mentionsRepository.stanceSplit(symbol, socialSince), [] as unknown[]),
      safe(metricsRepository.positioningForTicker(symbol), null),
      safe(metricsRepository.pumpForTicker(symbol), null),
      safe(tickersRepository.narratives(symbol), [] as unknown[]),
      safe(tickersRepository.ddQuality(symbol), [] as unknown[]),
      safe(tickersRepository.dailyMetrics(symbol, 14), [] as unknown[]),
      safe(alertsRepository.forTicker(symbol), [] as unknown[]),
      safe(marketRepository.shortInterest(symbol), null),
      safe(marketRepository.catalystsForTicker(symbol), [] as unknown[]),
    ]);

    return ok(res, {
      ticker,
      market,
      metrics,
      stance_split: stanceSplit,
      positioning,
      pump_coordination: pump,
      narratives,
      dd_quality: dd,
      mentions_over_time: daily,
      alerts,
      short_interest: shortInterest,
      catalysts,
      disclaimer: "Signals are informational only, not investment advice.",
    });
  }),
);

/**
 * GET /api/tickers/:ticker/reddit-mention-sentiment?range=24h&subreddits=a,b
 *
 * The Mention & Sentiment Pulse series: one bucket per interval with the
 * bullish/neutral/bearish split, unique authors, post/comment mix and the
 * same-hour historical average, plus a window summary.
 *
 * Reads stored Reddit content through Prisma. An unsupported range falls back to
 * 24h and unknown communities are dropped, so a hand-edited URL degrades instead
 * of erroring. No provider call happens here — hovering a bar or toggling a
 * community never leaves the database.
 */
tickersRouter.get(
  "/tickers/:ticker/reddit-mention-sentiment",
  asyncHandler(async (req, res) => {
    const range = isMentionRange(req.query.range) ? req.query.range : "24h";
    const subreddits = parseSubredditFilter(req.query.subreddits);
    const data = await getMentionSentimentSeries({
      ticker: req.params.ticker.toUpperCase(),
      range,
      subreddits,
    });
    return res.json({ success: true, data, meta: { ranges: MENTION_RANGES } });
  }),
);

/** GET /api/tickers/:ticker/mentions — mentions joined to their posts. */
tickersRouter.get(
  "/tickers/:ticker/mentions",
  asyncHandler(async (req, res) =>
    ok(res, await mentionsRepository.withPostForTicker(req.params.ticker.toUpperCase())),
  ),
);

/** GET /api/tickers/:ticker/bets — structured bets for a ticker. */
tickersRouter.get(
  "/tickers/:ticker/bets",
  asyncHandler(async (req, res) =>
    ok(res, await betsRepository.forTicker(req.params.ticker.toUpperCase())),
  ),
);

/** GET /api/tickers/:ticker/positioning — latest positioning index. */
tickersRouter.get(
  "/tickers/:ticker/positioning",
  asyncHandler(async (req, res) =>
    ok(res, await metricsRepository.positioningForTicker(req.params.ticker.toUpperCase())),
  ),
);

/** GET /api/tickers/:ticker/alerts — alerts for a ticker. */
tickersRouter.get(
  "/tickers/:ticker/alerts",
  asyncHandler(async (req, res) =>
    ok(res, await alertsRepository.forTicker(req.params.ticker.toUpperCase())),
  ),
);

/** GET /api/tickers/:ticker/narratives — narrative events + transitions. */
tickersRouter.get(
  "/tickers/:ticker/narratives",
  asyncHandler(async (req, res) =>
    ok(res, await metricsRepository.narrativesForTicker(req.params.ticker.toUpperCase())),
  ),
);

/** GET /api/tickers/:ticker/backtests — backtest runs (baseline sample). */
tickersRouter.get(
  "/tickers/:ticker/backtests",
  asyncHandler(async (_req, res) => ok(res, await backtestsRepository.listRuns(10))),
);
