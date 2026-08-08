import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTransientDbError, withDbRetry } from "../dbRetry.js";

/**
 * The retry exists to survive a brief pooler shortage. What matters most is
 * what it REFUSES to retry: repeating a deterministic failure three times only
 * multiplies the load that caused the shortage in the first place.
 */

class PrismaError extends Error {
  code: string;
  constructor(name: string, code: string, message = "boom") {
    super(message);
    this.name = name;
    this.code = code;
  }
}

const noSleep = async () => {};
const noJitter = () => 0;

describe("classifying failures", () => {
  it("treats pool exhaustion as transient", () => {
    assert.equal(
      isTransientDbError(new Error("FATAL: (EMAXCONNSESSION) max clients reached in session mode")),
      true,
    );
    assert.equal(isTransientDbError(new PrismaError("PrismaClientKnownRequestError", "P2024")), true);
    assert.equal(isTransientDbError(new Error("Can't reach database server at db:5432")), true);
    assert.equal(isTransientDbError(new Error("Connection terminated unexpectedly")), true);
  });

  it("treats logic errors as permanent", () => {
    // A unique-constraint violation fails identically every time.
    assert.equal(isTransientDbError(new PrismaError("PrismaClientKnownRequestError", "P2002")), false);
    assert.equal(isTransientDbError(new PrismaError("PrismaClientKnownRequestError", "P2025")), false);
    assert.equal(isTransientDbError(new PrismaError("PrismaClientValidationError", "")), false);
    assert.equal(isTransientDbError(new Error("column does not exist")), false);
    assert.equal(isTransientDbError(null), false);
  });
});

describe("withDbRetry", () => {
  it("returns the first success without waiting", async () => {
    let calls = 0;
    let slept = 0;
    const value = await withDbRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      { label: "t", sleep: async (ms) => void (slept += ms), random: noJitter },
    );
    assert.equal(value, "ok");
    assert.equal(calls, 1);
    assert.equal(slept, 0);
  });

  it("retries a transient failure and succeeds", async () => {
    let calls = 0;
    const value = await withDbRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("max clients reached");
        return "recovered";
      },
      { label: "t", sleep: noSleep, random: noJitter },
    );
    assert.equal(value, "recovered");
    assert.equal(calls, 3);
  });

  it("backs off exponentially rather than hammering the pooler", async () => {
    const delays: number[] = [];
    await assert.rejects(
      withDbRetry(
        async () => {
          throw new Error("max clients reached");
        },
        {
          label: "t",
          attempts: 4,
          baseDelayMs: 1_000,
          sleep: async (ms) => void delays.push(ms),
          random: noJitter,
        },
      ),
    );
    assert.deepEqual(delays, [1_000, 2_000, 4_000]);
  });

  it("caps a single delay", async () => {
    const delays: number[] = [];
    await assert.rejects(
      withDbRetry(async () => { throw new Error("max clients reached"); }, {
        label: "t",
        attempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 2_500,
        sleep: async (ms) => void delays.push(ms),
        random: noJitter,
      }),
    );
    assert.ok(delays.every((d) => d <= 2_500), `delays were ${delays}`);
  });

  it("gives up after the last attempt and rethrows the original error", async () => {
    let calls = 0;
    await assert.rejects(
      withDbRetry(
        async () => {
          calls += 1;
          throw new Error("max clients reached");
        },
        { label: "t", attempts: 3, sleep: noSleep, random: noJitter },
      ),
      /max clients reached/,
    );
    assert.equal(calls, 3);
  });

  it("does not retry a permanent failure at all", async () => {
    let calls = 0;
    await assert.rejects(
      withDbRetry(
        async () => {
          calls += 1;
          throw new PrismaError("PrismaClientKnownRequestError", "P2002", "unique constraint");
        },
        { label: "t", sleep: noSleep, random: noJitter },
      ),
    );
    assert.equal(calls, 1, "a deterministic failure must not be repeated");
  });

  it("never creates a client — it only calls what it was given", async () => {
    // The operation is the ONLY thing invoked; there is no reconnect path that
    // could quietly open a second pool.
    const seen: string[] = [];
    await withDbRetry(
      async () => {
        seen.push("operation");
        return 1;
      },
      { label: "t", sleep: noSleep, random: noJitter },
    );
    assert.deepEqual(seen, ["operation"]);
  });
});
