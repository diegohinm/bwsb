import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunk, readCandleParams } from "../databentoWorker.js";
import { MARKET_PRIORITY, MAX_ATTEMPTS } from "../../../services/market-data/marketDataQueue.service.js";

/**
 * The market worker's decisions that do not need a database or a provider.
 *
 * Batching is the one that matters most: it is the difference between twenty
 * queued symbols costing one upstream request and costing twenty, which is the
 * whole reason the queue exists rather than a loop of single fetches.
 */

describe("batching symbols into upstream requests", () => {
  it("sends fifty symbols as one request, not fifty", () => {
    const symbols = Array.from({ length: 50 }, (_, i) => `SYM${i}`);
    assert.equal(chunk(symbols, 50).length, 1);
  });

  it("splits past the batch size rather than sending an oversized request", () => {
    const symbols = Array.from({ length: 120 }, (_, i) => `SYM${i}`);
    const batches = chunk(symbols, 50);

    assert.deepEqual(batches.map((b) => b.length), [50, 50, 20]);
  });

  it("loses nothing and duplicates nothing when splitting", () => {
    const symbols = Array.from({ length: 137 }, (_, i) => `SYM${i}`);
    const flattened = chunk(symbols, 50).flat();

    assert.deepEqual(flattened, symbols);
    assert.equal(new Set(flattened).size, symbols.length);
  });

  it("returns nothing for an empty queue rather than one empty request", () => {
    assert.deepEqual(chunk([], 50), []);
  });
});

describe("reading a candle job's request", () => {
  const valid = { interval: "1d", from: "2026-09-01T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" };

  it("accepts a well-formed request", () => {
    const parsed = readCandleParams(valid);
    assert.equal(parsed?.interval, "1d");
    assert.equal(parsed?.from, valid.from);
  });

  it("rejects an interval the provider has no dataset for", () => {
    assert.equal(readCandleParams({ ...valid, interval: "3y" }), null);
  });

  it("rejects an unparseable date instead of asking for it", () => {
    assert.equal(readCandleParams({ ...valid, from: "last tuesday" }), null);
  });

  it("rejects a row whose params were never written", () => {
    assert.equal(readCandleParams(null), null);
    assert.equal(readCandleParams({}), null);
    assert.equal(readCandleParams("1d"), null);
  });
});

describe("queue priorities", () => {
  it("orders urgency from realtime down to background", () => {
    assert.ok(MARKET_PRIORITY.REALTIME < MARKET_PRIORITY.TRENDING);
    assert.ok(MARKET_PRIORITY.TRENDING < MARKET_PRIORITY.ACTIVE);
    assert.ok(MARKET_PRIORITY.ACTIVE < MARKET_PRIORITY.BACKGROUND);
  });

  it("stays inside the range the database CHECK constraint allows", () => {
    for (const priority of Object.values(MARKET_PRIORITY)) {
      assert.ok(priority >= 1 && priority <= 4, `priority ${priority} would be rejected`);
    }
  });

  it("gives up eventually, so a symbol the provider cannot serve stops costing slots", () => {
    assert.ok(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 10);
  });
});
