import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapWithConcurrency } from "../concurrency.js";

/**
 * The point of this helper is the CEILING. With a three-connection pool, a
 * hundred simultaneous queries do not fail on the data — they time out waiting
 * for a connection that a hundred siblings are also waiting for.
 */

function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await fn();
      } finally {
        inFlight -= 1;
      }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("never exceeds the limit", async () => {
    const t = tracker();
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      (n) => t.run(async () => { await tick(); return n; }),
      4,
    );
    assert.ok(t.peak() <= 4, `peak concurrency was ${t.peak()}`);
  });

  it("actually uses the window rather than going one at a time", async () => {
    const t = tracker();
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      (n) => t.run(async () => { await tick(); return n; }),
      4,
    );
    assert.equal(t.peak(), 4, "a sequential loop would waste the pool");
  });

  it("preserves input order regardless of completion order", async () => {
    const out = await mapWithConcurrency(
      [30, 10, 20, 0],
      async (ms) => {
        await new Promise((r) => setTimeout(r, ms / 10));
        return ms;
      },
      3,
    );
    assert.deepEqual(out, [30, 10, 20, 0]);
  });

  it("passes the index through", async () => {
    const out = await mapWithConcurrency(["a", "b", "c"], async (v, i) => `${i}:${v}`, 2);
    assert.deepEqual(out, ["0:a", "1:b", "2:c"]);
  });

  it("handles an empty list and a list shorter than the window", async () => {
    assert.deepEqual(await mapWithConcurrency([], async () => 1, 4), []);
    assert.deepEqual(await mapWithConcurrency([1], async (n) => n * 2, 8), [2]);
  });

  it("treats a nonsense limit as one rather than spawning nothing", async () => {
    const out = await mapWithConcurrency([1, 2, 3], async (n) => n, 0);
    assert.deepEqual(out, [1, 2, 3]);
  });

  it("rejects when a task throws, like Promise.all", async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("nope");
        return n;
      }, 2),
      /nope/,
    );
  });
});
