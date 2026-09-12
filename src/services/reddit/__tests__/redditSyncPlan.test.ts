import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { env } from "../../../config/env.js";
import { buildRedditConfig } from "../../../config/reddit.config.js";
import { ACTIVE_REDDIT_COMMUNITIES } from "../../../config/redditCommunities.js";
import {
  boundsForComments,
  boundsForPosts,
  isSaturated,
  nextRequestSize,
  nextSyncDelayMs,
  shouldRetire,
} from "../redditSyncPlan.js";
import { efficiencyOf, estimateCost, formatUsd } from "../mindcaseBudget.service.js";
import { commentIntervalMs, postsIntervalMs } from "../redditSync.service.js";

/**
 * THE COST ARITHMETIC.
 *
 * Mindcase bills per row RETURNED, so every assertion here is really about
 * money. The provider exposes exactly one lever — `maxResults` — and these are
 * the rules that decide what it is set to.
 */

const bounds = { min: 10, max: 50 };

describe("request sizing", () => {
  it("starts at the floor, not the ceiling", () => {
    // A cold start that guesses high pays for a full page before learning
    // anything, and the next sync would have corrected it anyway.
    assert.equal(nextRequestSize(null, bounds), 10);
  });

  it("shrinks when most of what we bought was already ours", () => {
    // 50 rows, 4 new — the old fixed-50 steady state. The next request should
    // be a fraction of that, which is where the saving actually comes from.
    const next = nextRequestSize({ rowsReceived: 50, newItems: 4, requested: 50 }, bounds);
    assert.ok(next <= 12, `expected a small follow-up request, got ${next}`);
    assert.ok(next >= bounds.min);
  });

  it("grows when every row was new, because there is probably more", () => {
    const next = nextRequestSize({ rowsReceived: 10, newItems: 10, requested: 10 }, bounds);
    assert.ok(next > 10, "a saturated response must widen the next window");
  });

  it("never exceeds the configured ceiling, however saturated", () => {
    const next = nextRequestSize({ rowsReceived: 50, newItems: 50, requested: 50 }, bounds);
    assert.equal(next, bounds.max);
  });

  it("never drops below the floor, however quiet", () => {
    const next = nextRequestSize({ rowsReceived: 30, newItems: 0, requested: 30 }, bounds);
    assert.equal(next, bounds.min);
  });

  it("leaves headroom above the last yield, so saturation stays detectable", () => {
    // Asking for exactly what arrived guarantees saturation on any uptick, and
    // a saturated sync cannot distinguish "caught up" from "there was more".
    const next = nextRequestSize({ rowsReceived: 40, newItems: 20, requested: 40 }, bounds);
    assert.ok(next > 20, `expected headroom over 20 new items, got ${next}`);
  });

  it("recognises saturation only when the response was non-empty", () => {
    assert.equal(isSaturated({ rowsReceived: 0, newItems: 0, requested: 10 }), false);
    assert.equal(isSaturated({ rowsReceived: 5, newItems: 5, requested: 5 }), true);
    assert.equal(isSaturated({ rowsReceived: 5, newItems: 4, requested: 5 }), false);
  });

  it("converges to the floor on a quiet stream rather than the ceiling", () => {
    // The steady state is what gets paid for all day. The old design's steady
    // state was 50; this one's is the floor.
    let outcome = { rowsReceived: 50, newItems: 3, requested: 50 };
    for (let i = 0; i < 5; i += 1) {
      const size = nextRequestSize(outcome, bounds);
      outcome = { rowsReceived: size, newItems: 3, requested: size };
    }
    assert.equal(nextRequestSize(outcome, bounds), bounds.min);
  });
});

describe("backoff and retirement", () => {
  it("uses the base interval while a stream is producing", () => {
    assert.equal(nextSyncDelayMs(60_000, 0), 60_000);
  });

  it("backs off geometrically once a stream goes quiet", () => {
    assert.equal(nextSyncDelayMs(60_000, 1), 120_000);
    assert.equal(nextSyncDelayMs(60_000, 2), 240_000);
  });

  it("caps the backoff so a dormant stream is still checked occasionally", () => {
    assert.equal(nextSyncDelayMs(60_000, 20), 60_000 * 8);
  });

  it("retires an ordinary thread that has gone quiet", () => {
    assert.equal(shouldRetire(env.REDDIT_THREAD_IDLE_RUNS, false), true);
  });

  it("NEVER retires a protected megathread", () => {
    // The Daily Discussion going quiet overnight must not remove it from the
    // rotation — it is the product's centre of gravity and will be busy again
    // at 09:30.
    assert.equal(shouldRetire(1_000, true), false);
  });
});

describe("deduplication is by id, not by timestamp", () => {
  it("keeps the overlap small enough to stay a rounding error", () => {
    // It no longer widens a time window — there is none. It buys a couple of
    // rows of request headroom, and a large value would give back the saving
    // for nothing, since ID dedup already cannot miss an item.
    assert.ok(
      env.REDDIT_SYNC_OVERLAP_SECONDS <= 120,
      "the overlap is headroom, not a re-fetch window",
    );
  });

  it("does not let the overlap inflate a request", () => {
    // Two rows of slack at most, whatever the overlap is set to.
    const quiet = { rowsReceived: 20, newItems: 2, requested: 20 };
    assert.ok(nextRequestSize(quiet, bounds) <= bounds.min + 2);
  });
});

describe("cost accounting", () => {
  it("prices a response by ROWS RETURNED, not by request", () => {
    // The observed invoice: 50 rows = $0.25.
    assert.equal(estimateCost(50), 0.25);
    assert.equal(formatUsd(estimateCost(50)), "$0.25");
    assert.equal(formatUsd(estimateCost(7)), "$0.0350");
  });

  it("reports a mostly-duplicate response as mostly wasted", () => {
    const report = efficiencyOf(50, 8);
    assert.equal(report.rowsReceived, 50);
    assert.equal(report.newItems, 8);
    assert.equal(report.duplicateItems, 42);
    assert.equal(report.estimatedCostUsd, 0.25);
    assert.equal(Math.round(report.newItemRate * 100), 16);
    assert.equal(Math.round(report.duplicateRate * 100), 84);
  });

  it("does not call a wholly wasted request infinitely expensive", () => {
    // We paid and got nothing. That is a statement, not a division by zero.
    const report = efficiencyOf(30, 0);
    assert.equal(report.costPerNewItem, null);
    assert.equal(report.duplicateRate, 1);
  });

  it("charges nothing for an empty response", () => {
    assert.equal(efficiencyOf(0, 0).estimatedCostUsd, 0);
  });
});

describe("cadence", () => {
  it("polls posts every ten minutes", () => {
    assert.equal(postsIntervalMs(), 10 * 60_000);
  });

  it("polls comments every minute while the market is open", () => {
    assert.equal(commentIntervalMs(true), 60_000);
  });

  it("polls comments every ten minutes while the market is closed", () => {
    assert.equal(commentIntervalMs(false), 10 * 60_000);
  });

  it("is always cheaper closed than open", () => {
    assert.ok(commentIntervalMs(false) > commentIntervalMs(true));
  });
});

describe("which communities are paid for", () => {
  it("ingests wallstreetbets and nothing else by default", () => {
    // The answer moved: it now comes from REDDIT_ACTIVE_COMMUNITIES via
    // config/redditCommunities, and the worker reads it through the backend
    // rather than from a list of its own. See redditCommunities.test.ts and
    // redditRuntimeConfig.test.ts for the full contract.
    assert.deepEqual([...ACTIVE_REDDIT_COMMUNITIES], ["wallstreetbets"]);
  });

  it("keeps multi-community support in the TRACKED catalog", () => {
    // Support was not removed — stocks/options/investing are still supported
    // and still readable from stored content. They are simply not active, so
    // nothing queries or buys them.
    const config = buildRedditConfig({
      REDDIT_SUBREDDITS: "wallstreetbets,stocks,options,investing,pennystocks",
    });
    assert.equal(config.subreddits.length, 5);
    assert.deepEqual([...ACTIVE_REDDIT_COMMUNITIES], ["wallstreetbets"]);
  });

  it("does not let the tracked catalog widen what gets billed", () => {
    // THE ORIGINAL BUG: these were one list, so adding a community to the
    // product silently multiplied the invoice.
    const config = buildRedditConfig({
      REDDIT_SUBREDDITS: "wallstreetbets,stocks,options,investing,pennystocks,technology",
    });
    assert.ok(config.subreddits.length > 1);
    assert.equal(ACTIVE_REDDIT_COMMUNITIES.length, 1);
    assert.ok(!ACTIVE_REDDIT_COMMUNITIES.includes("options"));
  });
});

describe("configured limits are conservative", () => {
  it("asks for well under the old fixed 50 rows", () => {
    assert.ok(boundsForPosts().max <= 30, "posts ceiling should be far below 50");
    assert.ok(boundsForComments().max <= 40);
  });

  it("caps pages per sync at two, not five", () => {
    assert.ok(env.REDDIT_MAX_PAGES_PER_SYNC <= 2);
  });

  it("bounds one comment sweep's spend to a knowable number of rows", () => {
    const worstCaseRows = env.REDDIT_COMMENT_THREADS_PER_SYNC * boundsForComments().max;
    // At one sweep a minute during a 6.5h session this is the ceiling that
    // matters; the daily budget guard is the backstop behind it.
    assert.ok(worstCaseRows <= 200, `worst-case sweep is ${worstCaseRows} rows`);
  });
});
