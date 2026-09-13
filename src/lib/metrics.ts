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
  // ── Arctic Shift ─────────────────────────────────────────────────────────
  // The free archive that replaced Mindcase as the primary source. These exist
  // to make the SAVING provable rather than asserted: during healthy operation
  // the arctic_* counters move and every mindcase_* counter stays flat at zero.
  // Any movement on a mindcase_* counter is the fallback alarm, not noise.
  | "arctic_shift_requests_total"
  | "arctic_shift_posts_received_total"
  | "arctic_shift_comments_received_total"
  | "arctic_shift_new_items_total"
  | "arctic_shift_duplicate_items_total"
  | "arctic_shift_errors_total"
  // ── Provider routing ─────────────────────────────────────────────────────
  // A point-in-time "which provider is active" cannot prove what happened over
  // a window, so occupancy is counted per cycle as well. `increment` can only
  // ADD, so a 0/1 flag counter is impossible — two counters is the shape that
  // works with this module's constraints.
  | "reddit_fallback_activations_total"
  | "reddit_fallback_recoveries_total"
  | "reddit_cycles_served_by_arctic_shift_total"
  | "reddit_cycles_served_by_mindcase_total"
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

/**
 * Archive lag, in seconds, observed on the most recent Arctic Shift fetch.
 *
 * A GAUGE, not a counter: the question it answers is "how far behind is the
 * archive right now", and a sum of every lag ever observed answers nothing.
 * `increment` can only add, so this cannot live in `counters` — it follows the
 * `estimatedMindcaseCostUsd` pattern instead: a module-level `let`, a
 * last-write-wins setter, and injection into `snapshot()` under a key that is
 * deliberately NOT a member of `MetricName`.
 *
 * Null until the first measurement, which is different from zero — "never
 * fetched" and "perfectly current" must not read the same.
 */
let arcticShiftLagSeconds: number | null = null;

export function setArcticShiftLagSeconds(seconds: number): void {
  arcticShiftLagSeconds = seconds;
}

export function readArcticShiftLagSeconds(): number | null {
  return arcticShiftLagSeconds;
}

/**
 * Which provider Reddit ingestion is currently served by.
 *
 * A STRING, so it cannot be a counter — `MetricsSnapshot.counters` is
 * `Record<string, number>`. It is surfaced as a top-level snapshot field beside
 * `uptimeSeconds`, which is where the health route already spreads non-numeric
 * values.
 */
let redditActiveProvider: "arctic_shift" | "mindcase" | "none" = "none";

export function setRedditActiveProvider(
  provider: "arctic_shift" | "mindcase" | "none",
): void {
  redditActiveProvider = provider;
}

export function readRedditActiveProvider(): string {
  return redditActiveProvider;
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
  /** `arctic_shift` | `mindcase` | `none`. A string, so never a counter. */
  redditActiveProvider: string;
  /** Archive lag of the last Arctic Shift fetch. Null before the first one. */
  arcticShiftLagSeconds: number | null;
};

export function snapshot(): MetricsSnapshot {
  const out: MetricsSnapshot = {
    counters: {},
    durations: {},
    uptimeSeconds: Math.round(process.uptime()),
    redditActiveProvider,
    arcticShiftLagSeconds,
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
  // The gauge and the provider string are module-level `let`s, so a test that
  // did not clear them here would leak state into the next test in the same
  // file — they share one process per file under the node test runner.
  arcticShiftLagSeconds = null;
  redditActiveProvider = "none";
}
