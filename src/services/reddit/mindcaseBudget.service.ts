import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { addMindcaseCost, increment, observeDuration } from "../../lib/metrics.js";

/**
 * WHAT MINDCASE COSTS, AND THE CEILING ON IT.
 *
 * THE BILLING MODEL, which everything here follows from: Mindcase charges per
 * ROW RETURNED — about $0.005 each — not per request. A response of fifty rows
 * already in the database costs exactly what fifty new ones cost. So:
 *
 *   - counting HTTP requests measures nothing that appears on the invoice;
 *   - deduplicating in Postgres saves storage and correctness, NOT money;
 *   - the only lever that saves money is the provider RETURNING FEWER ROWS.
 *
 * That distinction is why `newItems` and `duplicateItems` are recorded next to
 * `rowsReceived` rather than instead of it. `rowsReceived` is the bill.
 * `duplicateItems` is how much of the bill was wasted.
 *
 * THE LEDGER IS A TABLE, NOT A COUNTER. An in-process counter resets on every
 * deploy, so "at most $50 today" would not survive one — and a crash-looping
 * worker with an in-memory budget is an unbounded invoice. The limit has to be
 * enforced against something that remembers.
 *
 * WHAT EXCEEDING THE BUDGET DOES: pauses INGESTION. Nothing else. The API,
 * Discussion, search, the summary, Top and Hot Tickers all read Postgres and
 * keep working — data simply stops getting fresher. Taking the product down to
 * protect a bill would be a worse outcome than the bill.
 */

export const POSTS_AGENT = "reddit/posts" as const;
export const COMMENTS_AGENT = "reddit/comments" as const;
export type MindcaseAgent = typeof POSTS_AGENT | typeof COMMENTS_AGENT;

export type UsageRecord = {
  agent: MindcaseAgent;
  community: string;
  threadId?: string;
  /** THE BILLABLE NUMBER: how many rows the provider returned. */
  rowsReceived: number;
  /** Of those, how many were not already stored. */
  newItems: number;
  durationMs?: number;
  outcome?: "success" | "empty" | "error";
  error?: string;
};

export function estimateCost(rows: number): number {
  return Math.max(0, rows) * env.MINDCASE_COST_PER_RESULT_USD;
}

/**
 * `$0.25`, for a log line a human reads.
 *
 * Four decimals below a dime, two above. Cents are the wrong resolution for
 * this provider: a seven-row response costs $0.035, and rounding that to "$0.04"
 * both overstates it and makes a string of small responses indistinguishable
 * from each other — which is exactly the regime a well-tuned sync lives in.
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 0.1 ? 4 : 2)}`;
}

export type EfficiencyReport = {
  rowsReceived: number;
  newItems: number;
  duplicateItems: number;
  estimatedCostUsd: number;
  /** Share of billed rows that were worth paying for, 0–1. */
  newItemRate: number;
  duplicateRate: number;
  /** Dollars per item actually gained. Null when nothing was gained. */
  costPerNewItem: number | null;
};

export function efficiencyOf(rowsReceived: number, newItems: number): EfficiencyReport {
  const rows = Math.max(0, rowsReceived);
  const fresh = Math.max(0, Math.min(newItems, rows));
  const duplicates = rows - fresh;
  const cost = estimateCost(rows);

  return {
    rowsReceived: rows,
    newItems: fresh,
    duplicateItems: duplicates,
    estimatedCostUsd: cost,
    newItemRate: rows > 0 ? fresh / rows : 0,
    duplicateRate: rows > 0 ? duplicates / rows : 0,
    // Undefined rather than Infinity when nothing was new: dividing by zero is
    // not "infinitely expensive", it is a different statement — we paid and got
    // nothing — and the caller should say that rather than print Infinity.
    costPerNewItem: fresh > 0 ? cost / fresh : null,
  };
}

/** Duplicate share above which a run is worth complaining about. */
const HIGH_DUPLICATE_RATE = 0.8;

/**
 * Record one provider response and report what it cost.
 *
 * ALSO CALLED ON FAILURE. A request that errored after the provider had already
 * produced rows still billed for them; recording only successes would
 * understate spend exactly when something is going wrong.
 */
export async function recordMindcaseUsage(usage: UsageRecord): Promise<EfficiencyReport> {
  const report = efficiencyOf(usage.rowsReceived, usage.newItems);
  const outcome = usage.outcome ?? (report.rowsReceived === 0 ? "empty" : "success");

  increment("mindcase_requests_total");
  addMindcaseCost(report.estimatedCostUsd);
  increment("mindcase_rows_received_total", report.rowsReceived);
  increment("mindcase_new_items_total", report.newItems);
  increment("mindcase_duplicate_items_total", report.duplicateItems);
  increment(
    usage.agent === POSTS_AGENT
      ? "mindcase_posts_received_total"
      : "mindcase_comments_received_total",
    report.rowsReceived,
  );
  if (outcome === "error") increment("mindcase_sync_errors_total");
  if (usage.durationMs !== undefined) {
    observeDuration(
      usage.agent === POSTS_AGENT
        ? "reddit_posts_sync_duration_ms"
        : "reddit_comments_sync_duration_ms",
      usage.durationMs,
    );
  }

  // A HIGH DUPLICATE RATE IS A COST BUG, not a statistic — it means we are
  // paying full price for data we already own. Loud, and deliberately not
  // followed by fetching more pages.
  if (report.rowsReceived > 0 && report.duplicateRate > HIGH_DUPLICATE_RATE) {
    console.warn(
      `[MINDCASE COST WARNING] High duplicate rate. The provider is returning mostly ` +
        `previously stored data. agent=${usage.agent} community=${usage.community} ` +
        `rows=${report.rowsReceived} new=${report.newItems} ` +
        `duplicates=${report.duplicateItems} ` +
        `duplicateRate=${Math.round(report.duplicateRate * 100)}% ` +
        `wasted=${formatUsd(estimateCost(report.duplicateItems))}`,
    );
  }

  try {
    await prisma.mindcaseUsageEvent.create({
      data: {
        agent: usage.agent,
        community: usage.community,
        threadId: usage.threadId ?? "",
        rowsReceived: report.rowsReceived,
        newItems: report.newItems,
        duplicateItems: report.duplicateItems,
        estimatedCostUsd: new Prisma.Decimal(report.estimatedCostUsd.toFixed(6)),
        ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
        outcome,
        ...(usage.error ? { error: usage.error.slice(0, 500) } : {}),
      },
    });
  } catch (err) {
    // The ledger failing must not undo a sync that already succeeded and already
    // cost money. Logged loudly because a budget guard reading an incomplete
    // ledger under-counts spend, which is the failure direction that matters.
    console.error("[mindcase-budget] could not record usage (spend NOT counted):", err);
  }

  return report;
}

export type BudgetStatus = {
  allowed: boolean;
  /** Present when `allowed` is false — why, in words a log line can print. */
  reason: string | null;
  rowsLastHour: number;
  rowsToday: number;
  costTodayUsd: number;
  limits: {
    rowsPerHour: number;
    rowsPerDay: number;
    costPerDayUsd: number;
  };
};

/**
 * May we spend more?
 *
 * Checked BEFORE a request, never after: the point is to prevent the next row
 * from being bought, and a check that runs afterwards has already paid.
 *
 * "Today" is a rolling 24 hours rather than a calendar day in some timezone.
 * A calendar reset invites the failure mode where a runaway loop burns the
 * whole allowance at 23:59 and is handed a fresh one a minute later.
 *
 * A LIMIT OF ZERO MEANS UNLIMITED, matching how the other numeric guards in
 * this codebase read. Setting a real ceiling of zero — "never call Mindcase" —
 * is what SOCIAL_DATA_PROVIDER=off is for.
 */
export async function checkMindcaseBudget(now = new Date()): Promise<BudgetStatus> {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);

  const [hour, day] = await Promise.all([
    prisma.mindcaseUsageEvent.aggregate({
      where: { createdAt: { gte: hourAgo } },
      _sum: { rowsReceived: true },
    }),
    prisma.mindcaseUsageEvent.aggregate({
      where: { createdAt: { gte: dayAgo } },
      _sum: { rowsReceived: true, estimatedCostUsd: true },
    }),
  ]);

  const rowsLastHour = hour._sum.rowsReceived ?? 0;
  const rowsToday = day._sum.rowsReceived ?? 0;
  const costTodayUsd = Number(day._sum.estimatedCostUsd ?? 0);

  const limits = {
    rowsPerHour: env.MINDCASE_MAX_ROWS_PER_HOUR,
    rowsPerDay: env.MINDCASE_MAX_ROWS_PER_DAY,
    costPerDayUsd: env.MINDCASE_MAX_ESTIMATED_COST_PER_DAY_USD,
  };

  let reason: string | null = null;
  if (limits.rowsPerHour > 0 && rowsLastHour >= limits.rowsPerHour) {
    reason = `hourly row budget reached (${rowsLastHour}/${limits.rowsPerHour})`;
  } else if (limits.rowsPerDay > 0 && rowsToday >= limits.rowsPerDay) {
    reason = `daily row budget reached (${rowsToday}/${limits.rowsPerDay})`;
  } else if (limits.costPerDayUsd > 0 && costTodayUsd >= limits.costPerDayUsd) {
    reason =
      `daily cost budget reached (${formatUsd(costTodayUsd)}/` +
      `${formatUsd(limits.costPerDayUsd)})`;
  }

  if (reason) increment("mindcase_sync_skipped_budget_total");

  return { allowed: reason === null, reason, rowsLastHour, rowsToday, costTodayUsd, limits };
}

/**
 * Budget check that FAILS OPEN on a database error.
 *
 * Deliberate, and the reasoning is worth stating because it points the other
 * way from most safety guards: if Postgres is unreachable, ingestion is already
 * useless — there is nowhere to persist what we buy — and the sync will fail on
 * its first write anyway. Failing closed here would add nothing except a second
 * way for a transient database blip to look like a budget incident.
 *
 * The real ceiling is not this function; it is the request sizing, the page cap
 * and the boundary check, none of which depend on the ledger being readable.
 */
export async function budgetAllowsSpending(now = new Date()): Promise<BudgetStatus> {
  try {
    return await checkMindcaseBudget(now);
  } catch (err) {
    console.error("[mindcase-budget] ledger unreadable, proceeding without it:", err);
    return {
      allowed: true,
      reason: null,
      rowsLastHour: 0,
      rowsToday: 0,
      costTodayUsd: 0,
      limits: {
        rowsPerHour: env.MINDCASE_MAX_ROWS_PER_HOUR,
        rowsPerDay: env.MINDCASE_MAX_ROWS_PER_DAY,
        costPerDayUsd: env.MINDCASE_MAX_ESTIMATED_COST_PER_DAY_USD,
      },
    };
  }
}
