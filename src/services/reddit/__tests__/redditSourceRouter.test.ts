import "../../../providers/reddit/__tests__/helpers.js";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  readArcticShiftLagSeconds,
  readCounter,
  resetMetrics,
  setArcticShiftLagSeconds,
  setRedditActiveProvider,
  snapshot,
} from "../../../lib/metrics.js";
import {
  decideSource,
  decisionIsPaused,
  fetchForSource,
  FALLBACK_SOURCE,
  PRIMARY_SOURCE,
  type MeteredFetcher,
  type SourceDecision,
} from "../redditSourceRouter.js";
import type { SocialPostItem } from "../../social/socialData.types.js";

/**
 * THE RULE THAT DECIDES WHETHER MONEY IS SPENT.
 *
 * Every assertion here is really about the invoice. The migration's whole claim
 * is "zero metered requests while the free archive is healthy", and that claim
 * is only as good as these transitions: one blip must not switch providers,
 * three must, an expired bench must PROBE rather than assume, and a disabled
 * fallback must pause instead of paying.
 *
 * `decideSource` is pure, so this exercises the real production rule rather
 * than a re-description of it — no database, no clock, no network.
 */

const NOW = new Date("2026-09-12T15:30:00Z");
const MINUTE = 60_000;

const HEALTHY = { cooldownUntil: null, consecutiveFailures: 0 };
const FALLBACK_READY = { enabled: true, withinBudget: true };

describe("source decision — the healthy path", () => {
  it("uses the free archive when nothing is wrong", () => {
    const decision = decideSource(HEALTHY, FALLBACK_READY, NOW);
    assert.equal(decision.source, PRIMARY_SOURCE);
    assert.equal(decision.reason, "primary-healthy");
    assert.equal(decision.isProbe, false);
  });

  it("stays on the archive after ONE failure — a blip is not an outage", () => {
    // THE POINT OF THE THRESHOLD. An isolated timeout or 5xx is normal for any
    // network call. Switching upstream on the first one would make every blip
    // cost money, which is the failure this whole mechanism exists to avoid.
    // A single failure raises the counter but sets no bench, so the decision is
    // still the free source.
    const decision = decideSource(
      { cooldownUntil: null, consecutiveFailures: 1 },
      FALLBACK_READY,
      NOW,
    );
    assert.equal(decision.source, PRIMARY_SOURCE);
  });

  it("stays on the archive at one failure below the threshold", () => {
    const decision = decideSource(
      { cooldownUntil: null, consecutiveFailures: 2 },
      FALLBACK_READY,
      NOW,
    );
    assert.equal(decision.source, PRIMARY_SOURCE);
  });
});

describe("source decision — the fallback path", () => {
  it("uses the metered provider only while a bench is in force", () => {
    // The bench is what `recordFailure` writes once the failure count reaches
    // the threshold. Its presence — not the failure count — is what moves the
    // stream, so the state is durable and survives a restart.
    const decision = decideSource(
      { cooldownUntil: new Date(NOW.getTime() + 5 * MINUTE), consecutiveFailures: 3 },
      FALLBACK_READY,
      NOW,
    );
    assert.equal(decision.source, FALLBACK_SOURCE);
    assert.equal(decision.reason, "primary-benched");
  });

  it("PAUSES rather than pays when the fallback is switched off", () => {
    // A deliberate, safe production choice: an archive outage costs staleness
    // instead of dollars. The API keeps serving everything already stored.
    const decision = decideSource(
      { cooldownUntil: new Date(NOW.getTime() + 5 * MINUTE), consecutiveFailures: 3 },
      { enabled: false, withinBudget: true },
      NOW,
    );
    assert.equal(decision.reason, "fallback-disabled");
    assert.ok(decisionIsPaused(decision), "a disabled fallback must pause the cycle");
  });

  it("PAUSES rather than pays when the daily budget is exhausted", () => {
    const decision = decideSource(
      { cooldownUntil: new Date(NOW.getTime() + 5 * MINUTE), consecutiveFailures: 9 },
      { enabled: true, withinBudget: false },
      NOW,
    );
    assert.equal(decision.reason, "fallback-over-budget");
    assert.ok(decisionIsPaused(decision));
  });

  it("never reports a paused decision as a fetchable one", () => {
    // decisionIsPaused is what the jobs branch on; if it disagreed with the
    // reason the job would fetch from a benched source or an refused fallback.
    for (const reason of ["primary-healthy", "primary-probe", "primary-benched"] as const) {
      assert.equal(
        decisionIsPaused({ source: PRIMARY_SOURCE, reason, isProbe: false }),
        false,
        `${reason} must be fetchable`,
      );
    }
  });
});

describe("recovery — automatic, and it costs one free request", () => {
  it("PROBES the archive the moment the bench expires", () => {
    // The bench expiring does not mean the archive is healthy; it means it is
    // time to find out. The probe is one free request. Nothing external has to
    // declare recovery, which is what makes it impossible to forget.
    const expired = new Date(NOW.getTime() - 1_000);
    const decision = decideSource(
      { cooldownUntil: expired, consecutiveFailures: 3 },
      FALLBACK_READY,
      NOW,
    );
    assert.equal(decision.source, PRIMARY_SOURCE, "an expired bench must return to the archive");
    assert.equal(decision.reason, "primary-probe");
    assert.equal(decision.isProbe, true, "a recovery attempt must be distinguishable in the log");
  });

  it("distinguishes a first-ever cycle from a recovery probe", () => {
    // Same source, same cost, different story — and an operator watching a
    // recovery needs to see which one is happening.
    assert.equal(decideSource(HEALTHY, FALLBACK_READY, NOW).isProbe, false);
    assert.equal(
      decideSource(
        { cooldownUntil: new Date(NOW.getTime() - 1), consecutiveFailures: 3 },
        FALLBACK_READY,
        NOW,
      ).isProbe,
      true,
    );
  });

  it("keeps using the fallback right up to the instant the bench expires", () => {
    const until = new Date(NOW.getTime() + 1);
    assert.equal(decideSource({ cooldownUntil: until, consecutiveFailures: 3 }, FALLBACK_READY, NOW).source, FALLBACK_SOURCE);
    // One millisecond later the sentence is served.
    const after = new Date(until.getTime());
    assert.equal(decideSource({ cooldownUntil: until, consecutiveFailures: 3 }, FALLBACK_READY, after).source, PRIMARY_SOURCE);
  });
});

describe("the state is durable, not in-process", () => {
  it("decides purely from the cursor row, so a restart changes nothing", () => {
    // THE DESIGN CLAIM UNDER TEST. An in-memory failure counter would reset on
    // every boot, so a crash-looping worker would re-authorize metered spend
    // each time it came up. `decideSource` has no state of its own: hand it the
    // same row after a "restart" and it must reach the same conclusion.
    const row = {
      cooldownUntil: new Date(NOW.getTime() + 3 * MINUTE),
      consecutiveFailures: 4,
    };
    const before = decideSource(row, FALLBACK_READY, NOW);
    // Simulate a process restart: nothing carried over but the row itself.
    const after = decideSource({ ...row }, FALLBACK_READY, NOW);
    assert.deepEqual(after, before);
    assert.equal(after.source, FALLBACK_SOURCE);
  });
});

// ── the fetch leg ────────────────────────────────────────────────────────────

function makeItem(id: string): SocialPostItem {
  return {
    id,
    provider: "arctic_shift",
    source: "arctic_shift",
    subreddit: "wallstreetbets",
    type: "post",
    title: `post ${id}`,
    createdAt: new Date("2026-09-12T15:00:00Z").toISOString(),
    tickers: [],
    sentiment: "neutral",
    stance: "neutral",
    confidence: 0.5,
    isScreenshot: false,
  };
}

/** Records which upstream was actually contacted. That is the whole assertion. */
function spyArctic(result?: Partial<{ items: SocialPostItem[]; lagSeconds: number }>) {
  const calls: { after: Date | null; limit: number }[] = [];
  return {
    calls,
    fetchPosts: async (p: { after: Date | null; limit: number }) => {
      calls.push({ after: p.after, limit: p.limit });
      return {
        items: result?.items ?? [makeItem("a1")],
        receivedCount: 1,
        hasMore: false,
        lagSeconds: result?.lagSeconds ?? 30,
        newestSeenAt: new Date("2026-09-12T15:00:00Z"),
        newestSeenId: "a1",
      };
    },
    fetchComments: async (p: { after: Date | null; limit: number }) => {
      calls.push({ after: p.after, limit: p.limit });
      return {
        items: result?.items ?? [],
        receivedCount: 0,
        hasMore: false,
        lagSeconds: result?.lagSeconds ?? 30,
        newestSeenAt: null,
        newestSeenId: null,
      };
    },
  };
}

function spyMetered(): MeteredFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchPosts: async () => {
      calls.push("posts");
      return [makeItem("m1")];
    },
    fetchComments: async () => {
      calls.push("comments");
      return [];
    },
  };
}

const RESOURCE = { community: "wallstreetbets", stream: "POSTS" as const, threadId: "" };
const WINDOW = {
  after: new Date("2026-09-12T14:59:30Z"),
  before: new Date("2026-09-12T15:30:00Z"),
};

const healthyDecision: SourceDecision = {
  source: PRIMARY_SOURCE,
  reason: "primary-healthy",
  isProbe: false,
};
const benchedDecision: SourceDecision = {
  source: FALLBACK_SOURCE,
  reason: "primary-benched",
  isProbe: false,
};

describe("exactly one upstream per cycle", () => {
  beforeEach(() => resetMetrics());

  it("contacts the archive and NOT the metered provider when healthy", async () => {
    // THE HEADLINE ASSERTION OF THE MIGRATION. Not "mostly the archive" — the
    // metered spy must record zero calls, and the metered counters must not move.
    const arctic = spyArctic();
    const metered = spyMetered();

    await fetchForSource({
      decision: healthyDecision,
      resource: RESOURCE,
      maxResults: 100,
      window: WINDOW,
      deps: { arctic, metered },
    });

    assert.equal(metered.calls.length, 0, "the metered provider must not be contacted");
    assert.equal(arctic.calls.length, 1);
    assert.equal(readCounter("mindcase_requests_total"), 0);
    assert.equal(readCounter("reddit_cycles_served_by_mindcase_total"), 0);
    assert.equal(readCounter("reddit_cycles_served_by_arctic_shift_total"), 1);
    assert.equal(snapshot().redditActiveProvider, "arctic_shift");
  });

  it("contacts the metered provider and NOT the archive when benched", async () => {
    const arctic = spyArctic();
    const metered = spyMetered();

    await fetchForSource({
      decision: benchedDecision,
      resource: RESOURCE,
      maxResults: 20,
      window: WINDOW,
      deps: { arctic, metered },
    });

    // NOT BOTH. A fallback that also ran the primary would be double ingestion
    // wearing a fallback's name, and would pay for data it already had free.
    assert.equal(arctic.calls.length, 0, "the archive must not be contacted during fallback");
    assert.equal(metered.calls.length, 1);
    assert.equal(readCounter("reddit_cycles_served_by_mindcase_total"), 1);
    assert.equal(snapshot().redditActiveProvider, "mindcase");
  });

  it("does not reach for the other provider when the chosen one throws", async () => {
    // The structural guarantee: no try/catch that calls the secondary. A failure
    // must propagate so the CALLER records it and ends the cycle; the fallback
    // is reached on a later tick, from durable state.
    const metered = spyMetered();
    const exploding = {
      fetchPosts: async () => {
        throw new Error("archive unreachable");
      },
      fetchComments: async () => {
        throw new Error("archive unreachable");
      },
    };

    await assert.rejects(
      fetchForSource({
        decision: healthyDecision,
        resource: RESOURCE,
        maxResults: 100,
        window: WINDOW,
        deps: { arctic: exploding, metered },
      }),
      /archive unreachable/,
    );
    assert.equal(metered.calls.length, 0, "a failed primary must NOT trigger an in-cycle fallback");
  });

  it("passes the overlap-widened window straight through to the archive", async () => {
    // The window is computed once, by the sync engine, and used verbatim. If the
    // router rebuilt it the two sources could disagree about what "new" means.
    const arctic = spyArctic();
    await fetchForSource({
      decision: healthyDecision,
      resource: RESOURCE,
      maxResults: 100,
      window: WINDOW,
      deps: { arctic, metered: spyMetered() },
    });
    assert.equal(arctic.calls[0]?.after?.toISOString(), WINDOW.after.toISOString());
    assert.equal(arctic.calls[0]?.limit, 100);
  });

  it("refuses to guess when the fallback is selected but not wired", async () => {
    // Better a loud error than a silent no-op that reads as a quiet community.
    await assert.rejects(
      fetchForSource({
        decision: benchedDecision,
        resource: RESOURCE,
        maxResults: 20,
        window: WINDOW,
        deps: { arctic: spyArctic() },
      }),
      /no metered fetcher/i,
    );
  });

  it("records archive lag as a gauge, last-write-wins", () => {
    // A GAUGE, NOT A COUNTER. A sum of every lag ever observed answers nothing;
    // the question is "how far behind is the archive right now", so the newest
    // measurement must REPLACE the previous one rather than add to it.
    resetMetrics();
    assert.equal(snapshot().arcticShiftLagSeconds, null, "unmeasured is null, not zero");

    setArcticShiftLagSeconds(30);
    assert.equal(readArcticShiftLagSeconds(), 30);
    assert.equal(snapshot().arcticShiftLagSeconds, 30, "the gauge must reach the snapshot");

    setArcticShiftLagSeconds(12);
    assert.equal(snapshot().arcticShiftLagSeconds, 12, "last write wins — 12, not 42");

    // Zero is a real measurement (a perfectly current archive) and must survive
    // as 0 rather than being coerced back to "unknown".
    setArcticShiftLagSeconds(0);
    assert.equal(snapshot().arcticShiftLagSeconds, 0);
  });

  it("clears the gauge and the provider string on reset, so tests cannot leak state", () => {
    // Both are module-level values and the runner shares one process per file.
    setArcticShiftLagSeconds(99);
    setRedditActiveProvider("mindcase");
    resetMetrics();
    assert.equal(snapshot().arcticShiftLagSeconds, null);
    assert.equal(snapshot().redditActiveProvider, "none");
  });

  it("keeps the provider string out of the numeric counters", () => {
    // `MetricsSnapshot.counters` is Record<string, number>; a string literally
    // cannot live there, which is why this is a top-level field.
    setRedditActiveProvider("arctic_shift");
    const snap = snapshot();
    assert.equal(snap.redditActiveProvider, "arctic_shift");
    for (const value of Object.values(snap.counters)) {
      assert.equal(typeof value, "number");
    }
  });
});
