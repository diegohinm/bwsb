/**
 * backtestEngine.service.ts
 *
 * Deterministic baseline backtester. Accepts a JSON query, filters the seeded
 * bet_performance sample, and computes summary statistics. A real engine can
 * later replace the sample source without changing the interface.
 */
import { backtestsRepository } from "../../repositories/backtests.repository.js";

export interface BacktestQuery {
  name?: string;
  filters?: {
    ticker?: string;
    direction?: string;
    instrument?: string;
    option_type?: string;
    min_verification?: string;
  };
  hold_days?: number;
}

export interface BacktestSummary {
  observations: number;
  win_rate: number;
  median_return: number;
  average_return: number;
  max_drawdown: number;
  spy_adjusted_return: number;
  option_estimated_return: number;
  result_distribution: { buckets: Array<{ range: string; n: number }> };
}

const VERIFICATION_RANK: Record<string, number> = {
  unverified: 0,
  text_only: 1,
  screenshot_detected: 2,
  internally_consistent: 3,
  market_validated: 4,
  follow_up_verified: 5,
};

/** Run the backtest against the seeded sample and persist run + result. */
export async function runBacktest(
  query: BacktestQuery,
): Promise<{ runId: string; summary: BacktestSummary }> {
  const sample = (await backtestsRepository.betPerformanceSample()) as Array<{
    ticker: string;
    realized_return_pct: number | null;
    spy_adjusted_return: number | null;
    option_type: string | null;
    verification_level: string | null;
    direction: string | null;
    instrument: string | null;
  }>;

  const f = query.filters ?? {};
  const minRank = f.min_verification ? VERIFICATION_RANK[f.min_verification] ?? 0 : 0;

  const filtered = sample.filter((row) => {
    if (f.ticker && row.ticker !== f.ticker.toUpperCase()) return false;
    if (f.direction && row.direction !== f.direction) return false;
    if (f.instrument && row.instrument !== f.instrument) return false;
    if (f.option_type && row.option_type !== f.option_type) return false;
    if ((VERIFICATION_RANK[row.verification_level ?? "unverified"] ?? 0) < minRank)
      return false;
    return true;
  });

  const summary = summarize(filtered);

  const runId = (
    await backtestsRepository.insertRun(query.name ?? "Ad-hoc backtest", query)
  ).id;
  await backtestsRepository.insertResult(runId, {
    observations: summary.observations,
    win_rate: summary.win_rate,
    median_return: summary.median_return,
    average_return: summary.average_return,
    max_drawdown: summary.max_drawdown,
    spy_adjusted_return: summary.spy_adjusted_return,
    option_estimated_return: summary.option_estimated_return,
    result_distribution: summary.result_distribution,
  });

  return { runId, summary };
}

function summarize(
  rows: Array<{ realized_return_pct: number | null; spy_adjusted_return: number | null }>,
): BacktestSummary {
  const returns = rows
    .map((r) => Number(r.realized_return_pct))
    .filter((n) => Number.isFinite(n));
  const spy = rows
    .map((r) => Number(r.spy_adjusted_return))
    .filter((n) => Number.isFinite(n));

  if (returns.length === 0) {
    return {
      observations: 0,
      win_rate: 0,
      median_return: 0,
      average_return: 0,
      max_drawdown: 0,
      spy_adjusted_return: 0,
      option_estimated_return: 0,
      result_distribution: { buckets: [] },
    };
  }

  const sorted = [...returns].sort((a, b) => a - b);
  const wins = returns.filter((r) => r > 0).length;
  const avg = mean(returns);

  return {
    observations: returns.length,
    win_rate: round(wins / returns.length),
    median_return: round(median(sorted)),
    average_return: round(avg),
    max_drawdown: round(Math.min(...sorted)),
    spy_adjusted_return: round(mean(spy)),
    // Option positions are convex — estimate a leveraged proxy of the average.
    option_estimated_return: round(avg * 2.6),
    result_distribution: { buckets: distribution(returns) },
  };
}

function distribution(returns: number[]) {
  const ranges: Array<[string, (n: number) => boolean]> = [
    ["-100..-50", (n) => n < -50],
    ["-50..0", (n) => n >= -50 && n < 0],
    ["0..50", (n) => n >= 0 && n < 50],
    ["50..200", (n) => n >= 50],
  ];
  return ranges.map(([range, test]) => ({ range, n: returns.filter(test).length }));
}

const round = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (sorted: number[]) => {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
