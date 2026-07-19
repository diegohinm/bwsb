import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { tickersRepository } from "../repositories/tickers.repository.js";
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
    const ticker = await tickersRepository.findByTicker(symbol);
    if (!ticker) return fail(res, "Ticker not found", 404);

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
      marketRepository.latestSnapshot(symbol),
      metricsRepository.latest5mForTicker(symbol),
      mentionsRepository.stanceSplit(symbol),
      metricsRepository.positioningForTicker(symbol),
      metricsRepository.pumpForTicker(symbol),
      tickersRepository.narratives(symbol),
      tickersRepository.ddQuality(symbol),
      tickersRepository.dailyMetrics(symbol, 14),
      alertsRepository.forTicker(symbol),
      marketRepository.shortInterest(symbol),
      marketRepository.catalystsForTicker(symbol),
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
