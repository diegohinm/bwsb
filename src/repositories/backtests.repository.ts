import { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { toDbRow, toDbRows } from "../lib/rows.js";
import type { BacktestResult } from "../types/domain.js";

/**
 * Data access for backtest runs and their results.
 *
 * A run has at most one result row, so the LEFT JOIN the SQL used is expressed
 * as a nested read and then flattened back into the single row shape the
 * backtests routes serialize onto the wire (see lib/rows.ts for the column
 * naming).
 */

const RESULT_COLUMNS = {
  observations: true,
  winRate: true,
  medianReturn: true,
  averageReturn: true,
  maxDrawdown: true,
  spyAdjustedReturn: true,
  optionEstimatedReturn: true,
} as const;

type RunWithResult = {
  id: string;
  name: string | null;
  query: Prisma.JsonValue;
  createdAt: Date;
  backtestResults: Record<string, unknown>[];
};

/** Flatten `run + its result` into the single row the API returns. */
function flatten(run: RunWithResult): Record<string, unknown> {
  const [result] = run.backtestResults;
  return {
    ...toDbRow<Record<string, unknown>>("BacktestRuns", {
      id: run.id,
      name: run.name,
      query: run.query,
      createdAt: run.createdAt,
    }),
    // A run with no result still returns its columns as null, as the LEFT JOIN did.
    ...toDbRow<Record<string, unknown>>(
      "BacktestResults",
      result ?? Object.fromEntries(Object.keys(RESULT_COLUMNS).map((k) => [k, null])),
    ),
  };
}

export const backtestsRepository = {
  async listRuns(limit = 50) {
    const runs = await prisma.backtestRuns.findMany({
      select: {
        id: true,
        name: true,
        query: true,
        createdAt: true,
        backtestResults: { select: RESULT_COLUMNS, take: 1 },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return runs.map(flatten);
  },

  async runWithResult(runId: string) {
    const run = await prisma.backtestRuns.findUnique({
      where: { id: runId },
      select: {
        id: true,
        name: true,
        query: true,
        createdAt: true,
        backtestResults: {
          select: { ...RESULT_COLUMNS, resultDistribution: true },
          take: 1,
        },
      },
    });
    return run ? flatten(run) : null;
  },

  async insertRun(name: string, queryJson: unknown): Promise<{ id: string }> {
    return prisma.backtestRuns.create({
      data: { name, query: (queryJson ?? {}) as Prisma.InputJsonValue },
      select: { id: true },
    });
  },

  async insertResult(
    runId: string,
    result: Omit<BacktestResult, "id" | "backtest_run_id" | "created_at">,
  ) {
    const row = await prisma.backtestResults.create({
      data: {
        backtestRunId: runId,
        observations: result.observations,
        winRate: result.win_rate,
        medianReturn: result.median_return,
        averageReturn: result.average_return,
        maxDrawdown: result.max_drawdown,
        spyAdjustedReturn: result.spy_adjusted_return,
        optionEstimatedReturn: result.option_estimated_return,
        resultDistribution: (result.result_distribution ?? {}) as Prisma.InputJsonValue,
      },
    });
    return toDbRow<BacktestResult>("BacktestResults", row);
  },

  /** Seeded bet performance rows used as the sample for baseline backtests. */
  async betPerformanceSample() {
    // The JOIN on bets is an inner one: performance rows without a bet are
    // excluded, so the bet relation is required in the filter.
    const rows = await prisma.betPerformance.findMany({
      where: { bets: { isNot: null } },
      select: {
        ticker: true,
        realizedReturnPct: true,
        spyAdjustedReturn: true,
        outcome: true,
        bets: {
          select: {
            optionType: true,
            verificationLevel: true,
            direction: true,
            instrument: true,
          },
        },
      },
    });

    return rows.map(({ bets, ...performance }) => ({
      ...toDbRows<Record<string, unknown>>("BetPerformance", [performance])[0],
      ...toDbRows<Record<string, unknown>>("Bets", [bets ?? {}])[0],
    }));
  },
};
