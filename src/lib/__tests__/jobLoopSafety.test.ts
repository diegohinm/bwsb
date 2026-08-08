import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { startJobLoop } from "../jobRunner.js";

/**
 * The invariants that keep the connection pool from being oversubscribed.
 *
 * A `setInterval` does not wait for an async callback, so a job that runs
 * longer than its interval will be started again while the first is still
 * holding connections. These pin the guard that prevents it, and — just as
 * important — that the guard is RELEASED when a job fails, since a lock leaked
 * on the error path silently stops the job forever.
 */

const flush = () => new Promise((r) => setTimeout(r, 0));

/** worker_runs writes are irrelevant here and would need a real database. */
const record = async () => {};

let unblock: (() => void) | undefined;
const blocked = () =>
  new Promise<void>((resolve) => {
    unblock = resolve;
  });

beforeEach(() => {
  unblock = undefined;
});

describe("overlap protection", () => {
  it("skips a tick while the previous run is still in flight", async () => {
    let starts = 0;
    const loop = startJobLoop({
      name: "slow",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => {
        starts += 1;
        await blocked();
      },
    });

    // Let several intervals elapse while the first run is still hanging.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(starts, 1, "a slow job must never be started a second time");

    unblock?.();
    loop.stop();
  });

  it("reports that a run is in flight", async () => {
    const loop = startJobLoop({
      name: "inflight",
      intervalSeconds: 5,
      initialDelayMs: 0,
      record,
      run: async () => { await blocked(); },
    });

    await flush();
    assert.equal(loop.isRunning(), true);
    unblock?.();
    await flush();
    assert.equal(loop.isRunning(), false);
    loop.stop();
  });

  it("releases the lock after a successful run", async () => {
    let runs = 0;
    const loop = startJobLoop({
      name: "fast",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => { runs += 1; },
    });

    await new Promise((r) => setTimeout(r, 55));
    loop.stop();
    assert.ok(runs > 1, `the loop stopped after ${runs} run(s) — the lock leaked`);
  });

  it("releases the lock after a FAILED run, so the job is not lost forever", async () => {
    let runs = 0;
    const loop = startJobLoop({
      name: "failing",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => {
        runs += 1;
        throw new Error("database unavailable");
      },
    });

    await new Promise((r) => setTimeout(r, 55));
    loop.stop();
    assert.ok(runs > 1, "a scheduler must keep going after a recoverable failure");
    assert.equal(loop.isRunning(), false);
  });
});

describe("failures stay contained", () => {
  it("a rejecting job never becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", capture);

    const loop = startJobLoop({
      name: "throws",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => {
        throw Object.assign(new Error("max clients reached"), { code: "P2024" });
      },
    });

    await new Promise((r) => setTimeout(r, 60));
    loop.stop();
    process.off("unhandledRejection", capture);

    assert.deepEqual(unhandled, [], "the job runner must absorb its own failures");
  });

  it("one failing job does not stop an unrelated one", async () => {
    let healthy = 0;
    const bad = startJobLoop({
      name: "bad",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => { throw new Error("boom"); },
    });
    const good = startJobLoop({
      name: "good",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => { healthy += 1; },
    });

    await new Promise((r) => setTimeout(r, 55));
    bad.stop();
    good.stop();
    assert.ok(healthy > 1, "an unrelated job stopped running");
  });

  it("uses an independent lock per job", async () => {
    // A single shared flag would let a slow job block a fast, unrelated one.
    let fastRuns = 0;
    const slow = startJobLoop({
      name: "slowOne",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => { await blocked(); },
    });
    const fast = startJobLoop({
      name: "fastOne",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => { fastRuns += 1; },
    });

    await new Promise((r) => setTimeout(r, 55));
    assert.ok(fastRuns > 1, "the fast job was blocked by the slow one's lock");

    unblock?.();
    slow.stop();
    fast.stop();
  });
});

describe("stopping", () => {
  it("is idempotent", async () => {
    const loop = startJobLoop({
      name: "stoppable",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => {},
    });
    loop.stop();
    assert.doesNotThrow(() => loop.stop());
    assert.doesNotThrow(() => loop.stop());
  });

  it("starts no further runs once stopped", async () => {
    let runs = 0;
    const loop = startJobLoop({
      name: "stopped",
      intervalSeconds: 0.01,
      initialDelayMs: 0,
      record,
      run: async () => { runs += 1; },
    });
    await new Promise((r) => setTimeout(r, 30));
    loop.stop();
    const after = runs;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(runs, after, "the loop kept scheduling after stop()");
  });
});
