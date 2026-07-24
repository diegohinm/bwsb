import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { tickersRepository } from "../repositories/tickers.repository.js";
import { catalogTicker } from "../config/tickerCatalog.js";
import { mentionsRepository } from "../repositories/mentions.repository.js";
import { betsRepository } from "../repositories/bets.repository.js";
import { metricsRepository } from "../repositories/metrics.repository.js";
import { alertsRepository } from "../repositories/alerts.repository.js";
import { marketRepository } from "../repositories/market.repository.js";
import { backtestsRepository } from "../repositories/backtests.repository.js";

export const tickersRouter = Router();

/** GET /api/tickers — all tracked tickers. */
tickersRouter.get(
  "/tickers",
  asyncHandler(async (_req, res) => ok(res, await tickersRepository.listAll())),
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
      safe(mentionsRepository.stanceSplit(symbol), [] as unknown[]),
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
