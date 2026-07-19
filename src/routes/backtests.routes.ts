import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { backtestsRepository } from "../repositories/backtests.repository.js";
import { runBacktest, type BacktestQuery } from "../services/backtesting/backtestEngine.service.js";

export const backtestsRouter = Router();

/** GET /api/backtests — list backtest runs with their results. */
backtestsRouter.get(
  "/backtests",
  asyncHandler(async (_req, res) => ok(res, await backtestsRepository.listRuns())),
);

/** POST /api/backtests/run — run a backtest from a JSON query. */
backtestsRouter.post(
  "/backtests/run",
  asyncHandler(async (req, res) => {
    const query = (req.body ?? {}) as BacktestQuery;
    const { runId, summary } = await runBacktest(query);
    return ok(res, { run_id: runId, ...summary }, 201);
  }),
);

/** GET /api/backtests/:id — a single run with its result. */
backtestsRouter.get(
  "/backtests/:id",
  asyncHandler(async (req, res) => {
    const run = await backtestsRepository.runWithResult(req.params.id);
    if (!run) return fail(res, "Backtest run not found", 404);
    return ok(res, run);
  }),
);
