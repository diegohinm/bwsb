import {
  FakeClock,
  fakePost,
  memoryStore,
  testRedditConfig,
  type MemoryStore,
} from "./workerTestKit.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildArcticShiftWorkerConfig } from "../../../config/reddit.config.js";
import type { ArcticShiftPage, ArcticShiftPageInput } from "../../../providers/reddit/ArcticShiftProvider.js";
import { RedditProviderError } from "../../../providers/reddit/providerErrors.js";
import type { NormalizedRedditPost } from "../../../providers/reddit/types.js";
import type { PersistPostsResult } from "../../../services/redditIngestionService.js";
import { ArcticShiftRateGuard } from "../arcticShiftRateGuard.js";
import { ArcticShiftScheduler, selectSubreddit } from "../arcticShiftScheduler.js";
import {
  createArcticShiftWorker,
  deduplicate,
  latencyStats,
  runArcticShiftCycle,
  type CycleMetrics,
} from "../arcticShiftWorker.js";

/**
 * The Arctic Shift worker's contract with a free community archive.
 *
 * Every test here is about a promise that is expensive to break: one request
 * per cycle, five minutes apart, twelve an hour, no concurrency, no immediate
 * retry, and a cursor that never moves past data that was not written. The
 * clock is fake, so "five minutes" costs nothing to assert.
 */

const FIVE_MINUTES = 300_000;
const SUBREDDITS = ["wallstreetbets", "stocks", "options", "investing", "pennystocks"];

interface Harness {
  clock: FakeClock;
  store: MemoryStore;
  guard: ArcticShiftRateGuard;
  scheduler: ArcticShiftScheduler;
  /** Every fetch the cycle made, in order. */
  requests: ArcticShiftPageInput[];
  persisted: NormalizedRedditPost[][];
  run: (options?: { waitForSlot?: boolean }) => Promise<CycleMetrics>;
  deps: () => Parameters<typeof runArcticShiftCycle>[0];
}

function harness(options: {
  respond?: (input: ArcticShiftPageInput, call: number) => ArcticShiftPage | Promise<ArcticShiftPage>;
  persist?: (posts: NormalizedRedditPost[]) => Promise<PersistPostsResult>;
  store?: MemoryStore;
  configOverrides?: Record<string, string>;
  workerOverrides?: Record<string, string>;
} = {}): Harness {
  const clock = new FakeClock();
  const store = options.store ?? memoryStore();
  const config = testRedditConfig(options.configOverrides);
  const workerConfig = buildArcticShiftWorkerConfig({
    ARCTIC_SHIFT_MAX_RETRIES: "3",
    ...options.workerOverrides,
  });

  const guard = new ArcticShiftRateGuard({
    workerName: "arctic-shift-posts",
    store,
    now: clock.now,
    sleep: clock.sleep,
    minIntervalMs: config.pollIntervalMs,
  });
  const scheduler = new ArcticShiftScheduler({ store, subreddits: config.subreddits });

  const requests: ArcticShiftPageInput[] = [];
  const persisted: NormalizedRedditPost[][] = [];
  let call = 0;

  const deps = () => ({
    store,
    scheduler,
    guard,
    config,
    workerConfig,
    now: clock.now,
    fetchPage: async (input: ArcticShiftPageInput): Promise<ArcticShiftPage> => {
      requests.push(input);
      call += 1;
      // Every request costs time, exactly like a real one.
      clock.advance(500);
      if (options.respond) return options.respond(input, call);
      return {
        posts: [],
        receivedCount: 0,
        hasMore: false,
        after: input.after,
        before: input.before,
        limit: input.limit ?? 100,
      };
    },
    persist: async (posts: NormalizedRedditPost[]): Promise<PersistPostsResult> => {
      persisted.push(posts);
      if (options.persist) return options.persist(posts);
      return { insertedCount: posts.length, updatedCount: 0, failedCount: 0 };
    },
  });

  return {
    clock,
    store,
    guard,
    scheduler,
    requests,
    persisted,
    deps,
    run: (runOptions) => runArcticShiftCycle(deps(), runOptions ?? {}),
  };
}

function page(posts: NormalizedRedditPost[], hasMore = false): ArcticShiftPage {
  return {
    posts,
    receivedCount: posts.length,
    hasMore,
    after: undefined,
    before: undefined,
    limit: 100,
  };
}

// ── one request, five minutes apart ──────────────────────────────────────────

describe("request budget", () => {
  it("makes exactly one request per cycle", async () => {
    const kit = harness({ respond: () => page([fakePost(), fakePost()]) });
    await kit.run();
    assert.equal(kit.requests.length, 1);
  });

  it("keeps at least five minutes between two requests", async () => {
    const kit = harness({ respond: () => page([fakePost()]) });

    await kit.run();
    const first = kit.store.state.lastRequestAt?.getTime();
    assert.ok(first !== undefined);

    // Second cycle: the guard sleeps on the fake clock until the slot opens.
    await kit.run();
    const second = kit.store.state.lastRequestAt?.getTime();
    assert.ok(second !== undefined);
    assert.ok(
      second - first >= FIVE_MINUTES,
      `expected >= 300000ms between requests, saw ${second - first}ms`,
    );
  });

  it("never exceeds twelve requests in an hour", async () => {
    const kit = harness({ respond: () => page([fakePost()]) });

    // Run for a simulated 65 minutes.
    const deadline = kit.clock.now() + 65 * 60 * 1000;
    let cycles = 0;
    while (kit.clock.now() < deadline && cycles < 50) {
      await kit.run();
      cycles += 1;
      // Idle to the next slot exactly as the loop would.
      const nextAt = (await kit.guard.getNextAllowedAt()).getTime();
      await kit.clock.sleep(Math.max(0, nextAt - kit.clock.now()));
    }

    assert.ok(cycles > 0);
    // Any one-hour window holds at most 12 requests.
    const stamps = kit.store.state.requestLog.map((iso) => Date.parse(iso));
    for (const start of stamps) {
      const inWindow = stamps.filter((t) => t >= start && t < start + 3_600_000);
      assert.ok(
        inWindow.length <= 12,
        `found ${inWindow.length} requests in one hour starting ${new Date(start).toISOString()}`,
      );
    }
  });

  it("blocks and reports RATE_GUARD_TRIGGERED once the hourly ceiling is reached", async () => {
    const clock = new FakeClock();
    const store = memoryStore();
    // Twelve requests already made in the last hour, the oldest 10 minutes ago.
    store.state.requestLog = Array.from({ length: 12 }, (_, i) =>
      new Date(clock.now() - (10 - i * 0.5) * 60_000).toISOString(),
    );
    store.state.lastRequestAt = new Date(clock.now() - 6 * 60_000);

    const guard = new ArcticShiftRateGuard({
      workerName: "arctic-shift-posts",
      store,
      now: clock.now,
      sleep: clock.sleep,
    });

    const decision = await guard.check();
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "hourly_cap");
    assert.equal(await guard.requestsLastHour(), 12);
  });
});

// ── rotation ─────────────────────────────────────────────────────────────────

describe("round-robin rotation", () => {
  it("visits five subreddits in .env order and wraps around", async () => {
    const kit = harness({ respond: () => page([fakePost()]) });

    const visited: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const metrics = await kit.run();
      visited.push(metrics.subreddit);
    }

    assert.deepEqual(visited, [...SUBREDDITS, "wallstreetbets", "stocks"]);
  });

  it("resumes the rotation after a restart", async () => {
    const store = memoryStore();
    const first = harness({ store, respond: () => page([fakePost()]) });
    await first.run();
    await first.run();
    assert.equal(store.state.nextSubredditIndex, 2);

    // A "restart": brand-new scheduler and guard over the same stored state.
    const second = harness({ store, respond: () => page([fakePost()]) });
    const metrics = await second.run();
    assert.equal(metrics.subreddit, "options");
  });

  it("clamps a persisted index that a shorter list made invalid", async () => {
    const store = memoryStore("arctic-shift-posts", { nextSubredditIndex: 4 });
    const kit = harness({
      store,
      configOverrides: { REDDIT_SUBREDDITS: "wallstreetbets,stocks" },
      respond: () => page([fakePost()]),
    });

    const metrics = await kit.run();
    assert.equal(metrics.subreddit, "wallstreetbets");
    assert.equal(store.state.nextSubredditIndex, 1);
  });

  it("selectSubreddit is a pure step over the configured list", () => {
    assert.deepEqual(selectSubreddit(SUBREDDITS, 0), {
      subreddit: "wallstreetbets",
      index: 0,
      nextSubreddit: "stocks",
      nextIndex: 1,
    });
    assert.equal(selectSubreddit(SUBREDDITS, 4).nextIndex, 0);
    assert.equal(selectSubreddit(SUBREDDITS, 9).subreddit, "pennystocks");
    assert.throws(() => selectSubreddit([], 0), /empty/);
  });
});

// ── concurrency ──────────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("refuses a second cycle while a request is in flight", async () => {
    const kit = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const worker = createArcticShiftWorker({
      ...kit.deps(),
      fetchPage: async (input) => {
        kit.requests.push(input);
        await gate;
        return page([fakePost()]);
      },
      sleep: kit.clock.sleep,
      instanceId: "test-instance",
    });

    const firstCycle = worker.runOnce();
    // Second call arrives while the first is still awaiting the upstream.
    const secondResult = await worker.runOnce();
    assert.equal(secondResult, null, "the second cycle must be skipped, not queued");

    release();
    await firstCycle;
    assert.equal(kit.requests.length, 1);
  });

  it("skips the cycle when another instance holds the lease", async () => {
    const kit = harness();
    kit.store.leaseHolder = "another-render-instance";

    const worker = createArcticShiftWorker({
      ...kit.deps(),
      sleep: kit.clock.sleep,
      instanceId: "this-instance",
    });

    assert.equal(await worker.runOnce(), null);
    assert.equal(kit.requests.length, 0, "a leased-out cycle must make no request");
  });
});

// ── failures never retry immediately ─────────────────────────────────────────

describe("failure handling", () => {
  const timeout = (): never => {
    throw new RedditProviderError("arctic_shift", "timeout", "GET /api/posts/search timed out");
  };

  it("does not retry a timeout inside the same cycle", async () => {
    const kit = harness({ respond: timeout });
    const metrics = await kit.run();

    assert.equal(kit.requests.length, 1, "a timeout must not produce a second request");
    assert.equal(metrics.requestStatus, "TIMEOUT");
    assert.equal(kit.store.cursors.get("arctic_shift:wallstreetbets:post")?.lastCreatedAt, null);
  });

  it("honours Retry-After on a 429, with the five-minute floor", async () => {
    const kit = harness({
      respond: () => {
        throw new RedditProviderError("arctic_shift", "rate_limit", "429", 429, {
          retryAfterSeconds: 900,
        });
      },
    });

    const metrics = await kit.run();
    assert.equal(metrics.requestStatus, "RATE_LIMITED");

    const blockedUntil = kit.store.state.blockedUntil?.getTime();
    assert.ok(blockedUntil !== undefined);
    assert.ok(
      blockedUntil >= kit.clock.now() + 900_000 - 1_000,
      "a 15-minute Retry-After must be respected in full",
    );
    const decision = await kit.guard.check();
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "retry_after");
  });

  it("raises a short Retry-After to the five-minute minimum", async () => {
    const kit = harness({
      respond: () => {
        throw new RedditProviderError("arctic_shift", "rate_limit", "429", 429, {
          retryAfterSeconds: 30,
        });
      },
    });

    await kit.run();
    const blockedUntil = kit.store.state.blockedUntil?.getTime() ?? 0;
    assert.ok(
      blockedUntil >= kit.clock.now() + FIVE_MINUTES - 1_000,
      "the worker's own five-minute promise outranks a shorter Retry-After",
    );
  });

  it("continues with the next subreddit after an error", async () => {
    const kit = harness({
      respond: (_input, call) => {
        if (call === 1) timeout();
        return page([fakePost()]);
      },
    });

    const first = await kit.run();
    const second = await kit.run();
    assert.equal(first.subreddit, "wallstreetbets");
    assert.equal(first.requestStatus, "TIMEOUT");
    assert.equal(second.subreddit, "stocks");
    assert.equal(second.requestStatus, "SUCCESS");
  });

  it("cools a subreddit down after three consecutive failures, without a request", async () => {
    // A one-subreddit list so every cycle hits the same community.
    const kit = harness({
      configOverrides: { REDDIT_SUBREDDITS: "wallstreetbets" },
      respond: timeout,
    });

    await kit.run();
    await kit.run();
    const third = await kit.run();
    assert.equal(third.requestStatus, "TIMEOUT");

    const cursor = kit.store.cursors.get("arctic_shift:wallstreetbets:post");
    assert.equal(cursor?.consecutiveFailures, 3);
    assert.ok(cursor?.cooldownUntil, "three strikes must set a cooldown");

    const requestsBefore = kit.requests.length;
    const fourth = await kit.run();
    assert.equal(fourth.requestStatus, "SKIPPED_COOLDOWN");
    assert.equal(kit.requests.length, requestsBefore, "a cooled-down subreddit costs no request");
  });

  it("classifies a 4xx as VALIDATION_FAILED and keeps the cursor", async () => {
    const kit = harness({
      respond: () => {
        throw new RedditProviderError("arctic_shift", "client", "400", 400);
      },
    });
    const metrics = await kit.run();
    assert.equal(metrics.requestStatus, "VALIDATION_FAILED");
    assert.equal(metrics.httpStatus, 400);
  });

  it("counts failed requests against the hourly budget", async () => {
    const kit = harness({ respond: timeout });
    await kit.run();
    assert.equal(
      await kit.guard.requestsLastHour(),
      1,
      "a failed request consumed upstream capacity just like a successful one",
    );
    const decision = await kit.guard.check();
    assert.equal(decision.allowed, false, "the next attempt waits for the next slot");
  });
});

// ── cursor discipline ────────────────────────────────────────────────────────

describe("cursor", () => {
  const older = fakePost({
    externalId: "old1",
    createdAt: new Date("2026-07-31T09:40:00.000Z"),
  });
  const newer = fakePost({
    externalId: "new1",
    createdAt: new Date("2026-07-31T09:55:00.000Z"),
  });

  it("advances to the newest persisted post only after a successful write", async () => {
    const kit = harness({ respond: () => page([older, newer]) });
    await kit.run();

    const cursor = kit.store.cursors.get("arctic_shift:wallstreetbets:post");
    assert.equal(cursor?.lastCreatedAt?.toISOString(), newer.createdAt.toISOString());
    assert.equal(cursor?.lastExternalId, "new1");
  });

  it("does not move when persistence fails", async () => {
    const kit = harness({
      respond: () => page([older, newer]),
      persist: async () => {
        throw new Error("prisma: connection refused");
      },
    });

    const metrics = await kit.run();
    assert.equal(metrics.requestStatus, "PERSIST_FAILED");

    const cursor = kit.store.cursors.get("arctic_shift:wallstreetbets:post");
    assert.equal(
      cursor?.lastCreatedAt,
      null,
      "posts that were fetched but not written must stay inside the next window",
    );
  });

  it("keeps the existing cursor when the batch is empty", async () => {
    const kit = harness({
      respond: (_input, call) => (call === 1 ? page([newer]) : page([])),
      configOverrides: { REDDIT_SUBREDDITS: "wallstreetbets" },
    });

    await kit.run();
    const afterFirst = kit.store.cursors.get("arctic_shift:wallstreetbets:post")?.lastCreatedAt;
    await kit.run();
    const afterSecond = kit.store.cursors.get("arctic_shift:wallstreetbets:post")?.lastCreatedAt;

    assert.equal(afterSecond?.toISOString(), afterFirst?.toISOString());
    assert.equal(
      afterSecond?.toISOString(),
      newer.createdAt.toISOString(),
      "an empty response must never push the window forward to now",
    );
  });

  it("reads from the cursor minus the overlap on the next turn", async () => {
    const kit = harness({
      respond: (_input, call) => (call === 1 ? page([newer]) : page([])),
      configOverrides: { REDDIT_SUBREDDITS: "wallstreetbets" },
    });

    await kit.run();
    await kit.run();

    const second = kit.requests[1];
    assert.ok(second?.after);
    assert.equal(
      second.after.getTime(),
      newer.createdAt.getTime() - 120_000,
      "the window must reopen 120s before the cursor to survive indexing lag",
    );
    assert.equal(second.sort, "asc");
  });

  it("uses the initial look-back when there is no cursor", async () => {
    const kit = harness();
    await kit.run();

    const first = kit.requests[0];
    assert.ok(first?.after);
    assert.equal(first.after.getTime(), kit.clock.now() - 500 - 30 * 60_000);
  });
});

// ── full pages and duplicates ────────────────────────────────────────────────

describe("pagination and duplicates", () => {
  it("does not make a second request when a page comes back full", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      fakePost({
        externalId: `full${i}`,
        createdAt: new Date(Date.parse("2026-07-31T09:00:00.000Z") + i * 1_000),
      }),
    );
    const kit = harness({ respond: () => page(full, true) });

    const metrics = await kit.run();
    assert.equal(kit.requests.length, 1, "a full page must not trigger a follow-up request");
    assert.equal(metrics.hasMore, true);
    assert.equal(
      kit.store.cursors.get("arctic_shift:wallstreetbets:post")?.hasMore,
      true,
      "the next turn resumes from the cursor instead of jumping to now",
    );
  });

  it("collapses the overlap's duplicates by externalId", async () => {
    const duplicate = fakePost({ externalId: "same", score: 1 });
    const fresher = fakePost({ externalId: "same", score: 9 });
    const kit = harness({ respond: () => page([duplicate, fresher, fakePost()]) });

    const metrics = await kit.run();
    assert.equal(metrics.receivedCount, 3);
    assert.equal(metrics.normalizedCount, 2);
    assert.equal(metrics.duplicateCount, 1);

    const written = kit.persisted[0] ?? [];
    assert.equal(written.length, 2);
    assert.equal(
      written.find((post) => post.externalId === "same")?.score,
      9,
      "the fresher observation of a duplicate wins",
    );
  });

  it("deduplicate keeps one record per id", () => {
    const posts = [fakePost({ externalId: "a" }), fakePost({ externalId: "a" }), fakePost({ externalId: "b" })];
    assert.equal(deduplicate(posts).length, 2);
  });
});

// ── metrics ──────────────────────────────────────────────────────────────────

describe("metrics", () => {
  it("reports indexing latency percentiles", () => {
    const fetchedAt = new Date("2026-07-31T10:00:00.000Z");
    const posts = [10, 20, 30, 40, 100].map((seconds) =>
      fakePost({
        externalId: `lat${seconds}`,
        fetchedAt,
        createdAt: new Date(fetchedAt.getTime() - seconds * 1000),
      }),
    );

    const stats = latencyStats(posts);
    assert.deepEqual(stats, { minimum: 10, average: 40, p50: 30, p95: 100, maximum: 100 });
    assert.equal(latencyStats([]), null);
  });

  it("carries the whole cycle in one metrics row", async () => {
    const kit = harness({ respond: () => page([fakePost({ externalId: "m1" })]) });
    const metrics = await kit.run();

    assert.equal(metrics.provider, "arctic_shift");
    assert.equal(metrics.subreddit, "wallstreetbets");
    assert.equal(metrics.requestStatus, "SUCCESS");
    assert.equal(metrics.insertedCount, 1);
    assert.equal(metrics.requestsLastHour, 1);
    assert.equal(metrics.nextSubreddit, "stocks");
    assert.ok(Date.parse(metrics.nextRequestAt) >= kit.clock.now() + FIVE_MINUTES - 1_000);
    assert.ok(metrics.windowAfter && metrics.windowBefore);
    assert.ok(metrics.ingestionLatencySeconds);
  });
});
