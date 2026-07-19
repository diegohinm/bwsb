import { query, queryOne } from "../lib/db.js";
import type { BacktestResult } from "../types/domain.js";

export const backtestsRepository = {
  listRuns(limit = 50) {
    return query(
      `SELECT r.id, r.name, r.query, r.created_at,
              res.observations, res.win_rate, res.median_return, res.average_return,
              res.max_drawdown, res.spy_adjusted_return, res.option_estimated_return
       FROM public.backtest_runs r
       LEFT JOIN public.backtest_results res ON res.backtest_run_id = r.id
       ORDER BY r.created_at DESC LIMIT $1`,
      [limit],
    );
  },

  runWithResult(runId: string) {
    return queryOne(
      `SELECT r.id, r.name, r.query, r.created_at,
              res.observations, res.win_rate, res.median_return, res.average_return,
              res.max_drawdown, res.spy_adjusted_return, res.option_estimated_return, res.result_distribution
       FROM public.backtest_runs r
       LEFT JOIN public.backtest_results res ON res.backtest_run_id = r.id
       WHERE r.id = $1`,
      [runId],
    );
  },

  insertRun(name: string, queryJson: unknown): Promise<{ id: string }> {
    return queryOne<{ id: string }>(
      `INSERT INTO public.backtest_runs (name, query) VALUES ($1, $2::jsonb) RETURNING id`,
      [name, JSON.stringify(queryJson)],
    ) as Promise<{ id: string }>;
  },

  insertResult(
    runId: string,
    result: Omit<BacktestResult, "id" | "backtest_run_id" | "created_at">,
  ) {
    return queryOne<BacktestResult>(
      `INSERT INTO public.backtest_results
         (backtest_run_id, observations, win_rate, median_return, average_return,
          max_drawdown, spy_adjusted_return, option_estimated_return, result_distribution)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING *`,
      [
        runId,
        result.observations,
        result.win_rate,
        result.median_return,
        result.average_return,
        result.max_drawdown,
        result.spy_adjusted_return,
        result.option_estimated_return,
        JSON.stringify(result.result_distribution ?? {}),
      ],
    );
  },

  /** Seeded bet performance rows used as the sample for baseline backtests. */
  betPerformanceSample() {
    return query(
      `SELECT bp.ticker, bp.realized_return_pct, bp.spy_adjusted_return, bp.outcome,
              b.option_type, b.verification_level, b.direction, b.instrument
       FROM public.bet_performance bp
       JOIN public.bets b ON b.id = bp.bet_id`,
    );
  },
};
