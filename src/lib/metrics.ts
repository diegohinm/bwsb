/**
 * IN-PROCESS COUNTERS.
 *
 * The point of these is narrow and specific: making it possible to SHOW that
 * Databento usage fell after the Reddit/market split, rather than asserting it.
 * A claim like "Discussion no longer calls the provider" is worth exactly as
 * much as the number behind it, and before this module there was no number —
 * provider calls were visible only as lines in a log nobody aggregates.
 *
 * DELIBERATELY NOT A METRICS BACKEND. No Prometheus client, no StatsD, no
 * dependency at all: a Map of integers, readable over HTTP, reset when the
 * process restarts. The DO-NOT-DO list rules out new infrastructure for this
 * phase, and a counter that survives only as long as the process still answers
 * the question being asked — "how many Databento requests did serving this
 * traffic take?" — for any window shorter than a deploy.
 *
 * Each process has its own view. The API and the worker are separate deploys
 * and report separately, which is the useful split anyway: the API's Databento
 * counter is supposed to stay at zero, and the worker's is supposed to be the
 * only one that moves.
 */

/** Every counter this codebase increments, named once so typos cannot invent a new one. */
export type MetricName =
  // ── Mindcase cost ────────────────────────────────────────────────────────
  // The provider bills per ROW RETURNED, so `mindcase_rows_received_total` is
  // the invoice and `mindcase_requests_total` is trivia. Both are kept because
  // their RATIO is what says whether request sizing is working.
  | "mindcase_requests_total"
  | "mindcase_rows_received_total"
  | "mindcase_posts_received_total"
  | "mindcase_comments_received_total"
  | "mindcase_new_items_total"
  | "mindcase_duplicate_items_total"
  | "mindcase_sync_errors_total"
  | "mindcase_sync_skipped_budget_total"
  | "mindcase_sync_skipped_overlap_total"
  | "mindcase_sync_skipped_boundary_total"
  // ── Reddit pipeline ──────────────────────────────────────────────────────
  | "reddit_items_processed"
  | "reddit_mentions_created"
  | "reddit_ticker_candidates_rejected"
  | "reddit_activity_buckets_updated"
  // ── Read path ────────────────────────────────────────────────────────────
  | "discussion_queries"
  | "discussion_summary_queries"
  | "discussion_summary_from_aggregations"
  | "discussion_summary_from_raw_scan"
  // ── Market cache ─────────────────────────────────────────────────────────
  | "market_cache_hits"
  | "market_cache_misses"
  | "market_cache_stale_served"
  | "market_candle_cache_hits"
  | "market_candle_cache_misses"
  // ── Market queue ─────────────────────────────────────────────────────────
  | "market_jobs_enqueued"
  | "market_jobs_deduplicated"
  | "market_jobs_processed"
  | "market_jobs_failed"
  // ── The number this refactor exists to move ──────────────────────────────
  | "databento_requests"
  | "databento_symbols_requested"
  | "databento_errors";

const counters = new Map<MetricName, number>();

/**
 * Sum of every latency sample, with its count, so an average can be reported
 * without keeping the samples. A histogram would say more, but it would also be
 * the first step toward reimplementing a metrics library inside this file.
 */
const durations = new Map<string, { totalMs: number; count: number }>();

export function increment(name: MetricName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/**
 * Running estimate of what Mindcase has been paid since this process started.
 *
 * A separate accumulator because it is the one quantity here that is not a
 * count: dollars are fractional, and rounding $0.005 into an integer counter
 * would report every cheap request as free.
 */
let estimatedMindcaseCostUsd = 0;

export function addMindcaseCost(usd: number): void {
  estimatedMindcaseCostUsd += usd;
}

export function readMindcaseCost(): number {
  return estimatedMindcaseCostUsd;
}

export function observeDuration(name: string, ms: number): void {
  const prev = durations.get(name) ?? { totalMs: 0, count: 0 };
  durations.set(name, { totalMs: prev.totalMs + ms, count: prev.count + 1 });
}

/** Time an async call and record it, whether or not it throws. */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    observeDuration(name, Date.now() - started);
  }
}

export function readCounter(name: MetricName): number {
  return counters.get(name) ?? 0;
}

export type MetricsSnapshot = {
  counters: Record<string, number>;
  durations: Record<string, { count: number; totalMs: number; avgMs: number }>;
  /** Seconds this process has been counting. Counters are meaningless without it. */
  uptimeSeconds: number;
};

export function snapshot(): MetricsSnapshot {
  const out: MetricsSnapshot = {
    counters: {},
    durations: {},
    uptimeSeconds: Math.round(process.uptime()),
  };
  for (const [k, v] of counters) out.counters[k] = v;
  // Rounded to a tenth of a cent: more precision than that is noise, less would
  // hide the difference between a cheap hour and a free one.
  out.counters.mindcase_estimated_cost_usd_total =
    Math.round(estimatedMindcaseCostUsd * 10_000) / 10_000;
  for (const [k, v] of durations) {
    out.durations[k] = {
      count: v.count,
      totalMs: v.totalMs,
      avgMs: v.count > 0 ? Math.round(v.totalMs / v.count) : 0,
    };
  }
  return out;
}

/** Tests only — counters are cumulative for the life of the process otherwise. */
export function resetMetrics(): void {
  counters.clear();
  durations.clear();
  estimatedMindcaseCostUsd = 0;
}
