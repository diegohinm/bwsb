import { env } from "../../config/env.js";
import { increment, setRedditActiveProvider } from "../../lib/metrics.js";
import { getArcticShiftSource, type ArcticShiftSocialSource } from "../social/providers/arcticShiftSocialData.provider.js";
import { budgetAllowsSpending } from "./mindcaseBudget.service.js";
import { benchSource, readCursor, type FetchOutcome, type RedditSource, type StreamKind, type SyncWindow } from "./redditSync.service.js";
import type { SocialPostItem } from "../social/socialData.types.js";

/**
 * THE ONE PLACE THAT DECIDES WHICH UPSTREAM COLLECTS REDDIT DATA.
 *
 * WHAT WENT WRONG BEFORE. There were two independent selectors. `REDDIT_DATA_MODE`
 * chose a provider for the dormant provider-layer pipeline, while the jobs that
 * actually ran resolved theirs from `SOCIAL_DATA_PROVIDER` through the social
 * factory. Setting the first to the free archive therefore changed nothing at
 * all: the scheduled work kept resolving to the metered client and kept paying,
 * and both variables could be read as authoritative because each genuinely was
 * — for a different pipeline. Two truths, and the expensive one won.
 *
 * The fix is not a third variable. It is that ingestion asks exactly one
 * function, here, and that function consults exactly one configuration. The
 * social factory keeps its job — serving READ requests for status, pulse and
 * the ticker feed — and loses any say over what gets collected.
 *
 * THE INVARIANT, and the reason this file is shaped the way it is:
 *
 *     exactly one upstream is contacted per resource per cycle.
 *
 * Enforced structurally, not by discipline. `fetchForSource` awaits ONE
 * provider on every path and contains no `try { primary } catch { secondary }`.
 * A failing primary rethrows to the caller, which records the failure and ends
 * the cycle; the fallback can only be reached on a LATER tick, by which time
 * the durable state says so. That is the difference between a fallback and
 * double ingestion, and it is the whole reason the old
 * primary-then-secondary-in-one-call provider is not reused here.
 *
 * WHERE THE STATE LIVES. On the primary's cursor row — `consecutive_failures`
 * and `cooldown_until`, both already in the schema. Not in a module-level Map:
 * a per-process counter resets on every boot, so a worker in a crash loop would
 * re-authorize metered spend each time it came up, which is precisely the
 * failure mode a cost guard exists to prevent.
 */

/** The primary. Free, incremental, and the only source used when healthy. */
export const PRIMARY_SOURCE: RedditSource = "arctic_shift";
/** The fallback. Metered, so it runs only when the primary genuinely cannot. */
export const FALLBACK_SOURCE: RedditSource = "mindcase";

export type RedditResource = {
  community: string;
  stream: StreamKind;
  /** "" for the community-level stream; a bare Reddit id for one thread. */
  threadId: string;
};

export type SourceDecision = {
  source: RedditSource;
  /**
   * Why. Carried so the log line can explain a switch without the reader
   * having to reconstruct it from counters.
   */
  reason:
    | "primary-healthy"
    | "primary-probe"
    | "primary-benched"
    | "fallback-disabled"
    | "fallback-over-budget";
  /** True on the one tick that re-tests a benched primary. */
  isProbe: boolean;
};

function maxLagSeconds(): number {
  return env.ARCTIC_SHIFT_MAX_LAG_MINUTES * 60;
}

function cooldownMs(): number {
  return env.ARCTIC_SHIFT_RECOVERY_PROBE_MINUTES * 60_000;
}

/** What the durable cursor row says about the primary's health. */
export type PrimaryHealth = {
  /** While in the future, the primary is benched. Null = never benched. */
  cooldownUntil: Date | null;
  consecutiveFailures: number;
};

/** Whether the metered fallback is permitted to run at all, right now. */
export type FallbackAvailability = {
  enabled: boolean;
  withinBudget: boolean;
};

/**
 * THE DECISION, as a pure function.
 *
 * Separated from the I/O deliberately. This is the rule that decides whether
 * money is spent, and a rule that can only be exercised by standing up a
 * database and a clock is a rule that does not get exercised. Everything that
 * needs asserting — one failure is not enough, three are, an expired bench
 * probes rather than switches, a disabled fallback pauses instead of paying —
 * is a property of this function and is tested directly against it.
 */
export function decideSource(
  health: PrimaryHealth,
  fallback: FallbackAvailability,
  now: Date = new Date(),
): SourceDecision {
  const benchedUntil = health.cooldownUntil;
  const benched = benchedUntil !== null && benchedUntil.getTime() > now.getTime();

  if (!benched) {
    // A row that HAS been benched and whose sentence has expired is the probe
    // case; a row that never was is simply healthy. Both spend one free
    // request, but an operator watching a recovery needs to tell them apart.
    const isProbe = benchedUntil !== null;
    return {
      source: PRIMARY_SOURCE,
      reason: isProbe ? "primary-probe" : "primary-healthy",
      isProbe,
    };
  }

  // The primary is benched. Whether the fallback may run is a separate question
  // with its own answers, and "no" is always safe: ingestion pauses and the API
  // keeps serving whatever is already stored.
  if (!fallback.enabled) {
    return { source: PRIMARY_SOURCE, reason: "fallback-disabled", isProbe: false };
  }
  if (!fallback.withinBudget) {
    return { source: PRIMARY_SOURCE, reason: "fallback-over-budget", isProbe: false };
  }

  return { source: FALLBACK_SOURCE, reason: "primary-benched", isProbe: false };
}

/**
 * Which source owns this resource right now.
 *
 * Reads the PRIMARY's cursor row — "is the primary benched" is a fact about the
 * primary — and hands it to `decideSource`. No network, no writes.
 *
 * THE PROBE IS THE RECOVERY MECHANISM. When a bench expires this returns the
 * primary again rather than waiting for something to declare it healthy. The
 * next cycle spends one free request finding out; success clears the bench in
 * `commitCursor`, failure renews it in `recordFailure`. Nothing has to remember
 * to switch back, so recovery cannot be forgotten.
 */
export async function resolveSourceFor(
  resource: RedditResource,
  now: Date = new Date(),
): Promise<SourceDecision> {
  const cursor = await readCursor(
    resource.community,
    resource.stream,
    resource.threadId,
    PRIMARY_SOURCE,
  );

  const health: PrimaryHealth = {
    cooldownUntil: cursor.cooldownUntil,
    consecutiveFailures: cursor.consecutiveFailures,
  };

  const benched =
    cursor.cooldownUntil !== null && cursor.cooldownUntil.getTime() > now.getTime();

  // The budget is only consulted when it could actually matter. Asking on every
  // healthy cycle would be a database round-trip per tick to answer a question
  // whose answer cannot change the outcome.
  const withinBudget =
    benched && env.MINDCASE_FALLBACK_ENABLED ? (await budgetAllowsSpending()).allowed : false;

  return decideSource(
    health,
    { enabled: env.MINDCASE_FALLBACK_ENABLED, withinBudget },
    now,
  );
}

/**
 * Is this decision one where NOTHING should be fetched?
 *
 * When the primary is benched and the fallback is unavailable — switched off or
 * out of budget — the honest answer is to skip the cycle. Fetching from the
 * benched primary anyway would defeat the bench; fetching from the fallback
 * would defeat the guard that just refused it.
 */
export function decisionIsPaused(decision: SourceDecision): boolean {
  return decision.reason === "fallback-disabled" || decision.reason === "fallback-over-budget";
}

export type ArcticFetcher = Pick<ArcticShiftSocialSource, "fetchPosts" | "fetchComments">;

/** How the metered fallback is reached. Injected so tests never touch the network. */
export type MeteredFetcher = {
  fetchPosts(params: { community: string; maxResults: number }): Promise<SocialPostItem[]>;
  fetchComments(params: {
    community: string;
    threadId: string;
    maxResults: number;
  }): Promise<SocialPostItem[]>;
};

export type RouterDeps = {
  arctic?: ArcticFetcher;
  metered?: MeteredFetcher;
};

/**
 * Fetch one page for one resource from EXACTLY ONE upstream.
 *
 * Note what is absent: any catch that reaches for the other provider. An error
 * here propagates to `runSync`, which records the failure against this source's
 * cursor and returns. The decision to use the fallback is made by
 * `resolveSourceFor` on a subsequent tick, reading durable state — never inside
 * a single call, where "fallback" and "both providers ran" become the same
 * thing.
 */
export async function fetchForSource(params: {
  decision: SourceDecision;
  resource: RedditResource;
  maxResults: number;
  window: SyncWindow;
  deps?: RouterDeps;
}): Promise<FetchOutcome> {
  const { decision, resource, maxResults, window } = params;

  if (decision.source === FALLBACK_SOURCE) {
    const metered = params.deps?.metered;
    if (!metered) {
      throw new Error(
        "Reddit fallback selected but no metered fetcher is wired; refusing to guess.",
      );
    }
    increment("reddit_cycles_served_by_mindcase_total");
    setRedditActiveProvider("mindcase");
    const items =
      resource.stream === "POSTS"
        ? await metered.fetchPosts({ community: resource.community, maxResults })
        : await metered.fetchComments({
            community: resource.community,
            threadId: resource.threadId,
            maxResults,
          });
    // The metered provider has no server-side time filter, so it reports no
    // window position and no lag. Leaving `newestSeenAt` undefined keeps the
    // stored-only checkpoint rule for this source, which is the correct one
    // there — see the anti-pin note on commitCursor.
    return { items, lagSeconds: null };
  }

  const arctic = params.deps?.arctic ?? getArcticShiftSource();
  increment("reddit_cycles_served_by_arctic_shift_total");
  setRedditActiveProvider("arctic_shift");

  const result =
    resource.stream === "POSTS"
      ? await arctic.fetchPosts({
          community: resource.community,
          after: window.after,
          before: window.before,
          limit: maxResults,
        })
      : await arctic.fetchComments({
          community: resource.community,
          after: window.after,
          before: window.before,
          limit: maxResults,
          ...(resource.threadId ? { threadId: resource.threadId } : {}),
        });

  return {
    items: result.items,
    lagSeconds: result.lagSeconds,
    newestSeenAt: result.newestSeenAt,
    newestSeenId: result.newestSeenId,
    hasMore: result.hasMore,
  };
}

/**
 * Bench the primary when it is healthy but too far behind to be useful.
 *
 * Called AFTER a successful cycle, so the data collected on this pass is kept —
 * stale data is still data, and discarding it would turn a slow archive into a
 * hole. What it changes is who serves the NEXT cycle.
 *
 * Deliberately not folded into the failure counter: lag is not an error, and
 * conflating the two would make "the upstream is broken" and "the upstream is
 * merely behind" indistinguishable in the logs at the moment an operator most
 * needs to tell them apart.
 */
export async function benchPrimaryIfLagging(params: {
  resource: RedditResource;
  lagSeconds: number | null;
}): Promise<boolean> {
  const { resource, lagSeconds } = params;
  // Unmeasurable lag is NOT excessive lag. A page with no `retrieved_on` says
  // nothing about the archive's health, and treating silence as a fault would
  // hand the stream to a metered provider on no evidence at all.
  if (lagSeconds === null) return false;
  if (lagSeconds <= maxLagSeconds()) return false;
  if (!env.MINDCASE_FALLBACK_ENABLED) return false;

  await benchSource({
    community: resource.community,
    contentType: resource.stream,
    threadId: resource.threadId,
    provider: PRIMARY_SOURCE,
    cooldownMs: cooldownMs(),
    reason: `archive lag ${lagSeconds}s exceeds ${maxLagSeconds()}s`,
  });
  increment("reddit_fallback_activations_total");
  console.warn(
    `[FALLBACK ACTIVATED] stream=${resource.stream} community=${resource.community} ` +
      `reason=lag lagSeconds=${lagSeconds} thresholdSeconds=${maxLagSeconds()}`,
  );
  return true;
}

/** The knobs `runSync` needs so the failure threshold and bench live in one place. */
export function primaryFailurePolicy(): { failureThreshold: number; cooldownMs: number } {
  return {
    failureThreshold: env.ARCTIC_SHIFT_FAILURE_THRESHOLD,
    cooldownMs: cooldownMs(),
  };
}

export function overlapSecondsFor(source: RedditSource): number {
  // The metered provider ignores the window entirely, so its overlap only ever
  // tuned request headroom; the primary's overlap is a real time boundary.
  return source === PRIMARY_SOURCE
    ? env.ARCTIC_SHIFT_OVERLAP_SECONDS
    : env.REDDIT_SYNC_OVERLAP_SECONDS;
}

/** One-line, secret-free description of the routing policy. For the boot banner. */
export function describeRedditRouting(): string {
  return [
    "[reddit-provider]",
    `primary=${PRIMARY_SOURCE}`,
    `fallback=${env.MINDCASE_FALLBACK_ENABLED ? FALLBACK_SOURCE : "disabled"}`,
    `failureThreshold=${env.ARCTIC_SHIFT_FAILURE_THRESHOLD}`,
    `maxLagMinutes=${env.ARCTIC_SHIFT_MAX_LAG_MINUTES}`,
    `recoveryProbeMinutes=${env.ARCTIC_SHIFT_RECOVERY_PROBE_MINUTES}`,
    `overlapSeconds=${env.ARCTIC_SHIFT_OVERLAP_SECONDS}`,
    `maxPagesPerSync=${env.ARCTIC_SHIFT_MAX_PAGES_PER_SYNC}`,
  ].join(" ");
}
