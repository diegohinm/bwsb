import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredQuote } from "../../../repositories/marketSnapshots.repository.js";
import type { StoredTrendingTicker } from "../../../repositories/socialSnapshots.repository.js";
import {
  assembleTickerStrip,
  stripStaleAfterSeconds,
  type AssembleInput,
} from "../tickerStrip.service.js";

/**
 * The Dashboard ticker strip's read contract.
 *
 * Everything that decides what the tape SAYS is pure and tested here with the
 * database rows and the clock passed in: which rows are shown, which price each
 * gets, and which of ok / stale / empty the response declares. The one rule
 * every case defends: no row, price or label is invented to fill a gap.
 */

// Tue 2026-11-10 11:00 ET — inside a regular session.
const NOW = new Date("2026-11-10T16:00:00.000Z");
const SNAPSHOT = "2026-11-10T15:58:00.000Z";

function row(overrides: Partial<StoredTrendingTicker> = {}): StoredTrendingTicker {
  return {
    symbol: "NVDA",
    mentionCount: 39,
    stance: "bullish",
    price: 999.99, // the snapshot's own price — must NOT be what the strip serves
    changePct: 9.99,
    providerSocial: "arctic_shift",
    providerMarket: "databento",
    isMock: false,
    snapshotAt: SNAPSHOT,
    ...overrides,
  };
}

function quote(overrides: Partial<StoredQuote> = {}): StoredQuote {
  return {
    symbol: "NVDA",
    assetType: "equity",
    provider: "databento",
    source: "databento",
    displayMode: "delayed",
    session: "regular",
    price: 196.1,
    change: -10.56,
    changePct: -5.11,
    volume: 1000,
    timestamp: "2026-11-10T15:44:00.000Z",
    observedAt: "2026-11-10T15:44:00.000Z",
    isMock: false,
    isDelayed: true,
    delayMinutes: 15,
    storedAt: "2026-11-10T15:59:30.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    timeframe: "24h",
    limit: 12,
    rows: [row()],
    quotes: [quote()],
    now: NOW,
    marketOpen: true,
    staleAfterSeconds: 900,
    ...overrides,
  };
}

describe("ticker strip — real data", () => {
  it("serves the stored ranking joined with the stored delayed quote", () => {
    const { data, meta } = assembleTickerStrip(input());

    assert.equal(meta.status, "ok");
    assert.equal(meta.snapshotAt, SNAPSHOT);
    assert.equal(meta.social.provider, "arctic_shift");
    assert.deepEqual(data, [
      {
        symbol: "NVDA",
        mentionCount: 39,
        stance: "bullish",
        quote: {
          price: 196.1,
          changePct: -5.11,
          observedAt: "2026-11-10T15:44:00.000Z",
          provider: "databento",
          source: "databento",
          displayMode: "delayed",
          delayMinutes: 15,
          isLastRegularClose: false,
          isStale: false,
        },
      },
    ]);
    assert.equal(meta.market.provider, "databento");
    assert.equal(meta.market.displayMode, "delayed");
    assert.equal(meta.market.delayMinutes, 15);
    assert.equal(meta.market.quoted, 1);
    assert.equal(meta.market.missing, 0);
    assert.equal(meta.warning, null);
  });

  it("never serves the snapshot's frozen price — the quote comes from the quotes table", () => {
    const { data } = assembleTickerStrip(input());
    assert.notEqual(data[0].quote?.price, 999.99);
  });

  it("keeps the worker's ranking order and honours the limit", () => {
    const rows = [
      row({ symbol: "NVDA", mentionCount: 39 }),
      row({ symbol: "SPY", mentionCount: 12 }),
      row({ symbol: "GOOGL", mentionCount: 5 }),
    ];
    const { data } = assembleTickerStrip(input({ rows, limit: 2 }));
    assert.deepEqual(
      data.map((d) => d.symbol),
      ["NVDA", "SPY"],
    );
  });

  it("never labels a stored quote real-time", () => {
    const { data, meta } = assembleTickerStrip(
      input({ quotes: [quote({ displayMode: "realtime" })] }),
    );
    assert.equal(data[0].quote?.displayMode, "delayed");
    assert.equal(meta.market.displayMode, "delayed");
  });

  it("labels prices as the last close while the market is shut", () => {
    // Tue 2026-11-10 18:00 ET — after the close; the 15:59 bar is today's close.
    const evening = new Date("2026-11-10T23:00:00.000Z");
    const { data, meta } = assembleTickerStrip(
      input({
        now: evening,
        marketOpen: false,
        rows: [row({ snapshotAt: "2026-11-10T22:58:00.000Z" })],
        quotes: [quote({ observedAt: "2026-11-10T20:59:00.000Z" })],
      }),
    );
    assert.equal(data[0].quote?.isLastRegularClose, true);
    assert.equal(data[0].quote?.isStale, false, "today's close is the newest possible price");
    assert.equal(meta.market.marketOpen, false);
  });
});

describe("ticker strip — no fabricated rows or prices", () => {
  it("ships a symbol with no stored quote as mentions-only, not as demo", () => {
    const rows = [row({ symbol: "NVDA" }), row({ symbol: "CRWV", mentionCount: 4 })];
    const { data, meta } = assembleTickerStrip(input({ rows }));

    const crwv = data.find((d) => d.symbol === "CRWV");
    assert.ok(crwv, "a real Reddit mention is shown even without a price");
    assert.equal(crwv.mentionCount, 4);
    assert.equal(crwv.quote, null);
    assert.equal(meta.market.missing, 1);
    assert.match(meta.warning ?? "", /no stored quote/);
    // The response no longer has any notion of demo rows.
    assert.equal("isMock" in crwv, false);
    assert.equal("isMock" in meta, false);
  });

  it("refuses to show a mock quote as a price", () => {
    const { data } = assembleTickerStrip(
      input({ quotes: [quote({ isMock: true, provider: "mock", displayMode: "mock" })] }),
    );
    assert.equal(data[0].quote, null);
  });

  it("refuses a quote row with no price", () => {
    const { data } = assembleTickerStrip(input({ quotes: [quote({ price: null })] }));
    assert.equal(data[0].quote, null);
  });

  it("drops rows whose mentions came from the mock social provider", () => {
    const rows = [row({ symbol: "FAKE", providerSocial: "mock" }), row({ symbol: "NVDA" })];
    const { data } = assembleTickerStrip(input({ rows }));
    assert.deepEqual(
      data.map((d) => d.symbol),
      ["NVDA"],
    );
  });

  it("drops rows with no recorded provider or no mention count instead of filling them in", () => {
    const rows = [
      row({ symbol: "ANON", providerSocial: null }),
      row({ symbol: "NULLS", mentionCount: null }),
      row({ symbol: "ZERO", mentionCount: 0 }),
      row({ symbol: "NVDA" }),
    ];
    const { data } = assembleTickerStrip(input({ rows }));
    assert.deepEqual(
      data.map((d) => d.symbol),
      ["NVDA"],
    );
  });

  it("keeps an unknown stance unknown", () => {
    const { data } = assembleTickerStrip(input({ rows: [row({ stance: null })] }));
    assert.equal(data[0].stance, null);
  });

  it("keeps a legacy row whose only 'demo' flag was a missing quote", () => {
    // The old worker set is_mock whenever a quote was absent. The mentions on
    // such a row are real, so it is shown — with whatever price exists NOW.
    const { data } = assembleTickerStrip(
      input({ rows: [row({ isMock: true, providerMarket: "none" })] }),
    );
    assert.equal(data.length, 1);
    assert.equal(data[0].quote?.price, 196.1);
  });
});

describe("ticker strip — empty", () => {
  it("says the worker has never published when there is no snapshot", () => {
    const { data, meta } = assembleTickerStrip(input({ rows: [], quotes: [] }));
    assert.deepEqual(data, []);
    assert.equal(meta.status, "empty");
    assert.equal(meta.snapshotAt, null);
    assert.match(meta.warning ?? "", /not published/);
    assert.equal(meta.social.provider, null);
    assert.equal(meta.market.provider, null);
    assert.equal(meta.market.displayMode, null);
  });

  it("is empty — not a demo tape — when every stored row is unverifiable", () => {
    const { data, meta } = assembleTickerStrip(
      input({ rows: [row({ providerSocial: "mock" })] }),
    );
    assert.deepEqual(data, []);
    assert.equal(meta.status, "empty");
    assert.equal(meta.snapshotAt, SNAPSHOT);
    assert.match(meta.warning ?? "", /verified Reddit source/);
  });
});

describe("ticker strip — stale", () => {
  it("reports an old ranking as stale, with its snapshot time, and still serves it", () => {
    const old = "2026-11-10T14:00:00.000Z"; // two hours before NOW
    const { data, meta } = assembleTickerStrip(input({ rows: [row({ snapshotAt: old })] }));
    assert.equal(meta.status, "stale");
    assert.equal(meta.snapshotAt, old);
    assert.equal(data.length, 1);
    assert.match(meta.warning ?? "", /has not published a newer one/);
  });

  it("flags a price from an earlier session and keeps its date", () => {
    // Months old — the NVDA row the live database actually had.
    const { data, meta } = assembleTickerStrip(
      input({ quotes: [quote({ observedAt: "2026-07-27T23:49:00.000Z", session: "after_hours" })] }),
    );
    assert.equal(data[0].quote?.isStale, true);
    assert.equal(data[0].quote?.observedAt, "2026-07-27T23:49:00.000Z");
    assert.equal(meta.market.stale, 1);
  });

  it("does not call yesterday's close stale before today's first delayed bar can exist", () => {
    // 09:40 ET: the session has opened, but with a 15-minute delay no bar of
    // today can have been published yet.
    const justAfterOpen = new Date("2026-11-10T14:40:00.000Z");
    const { data } = assembleTickerStrip(
      input({
        now: justAfterOpen,
        rows: [row({ snapshotAt: "2026-11-10T14:39:00.000Z" })],
        quotes: [quote({ observedAt: "2026-11-09T20:59:00.000Z" })],
      }),
    );
    assert.equal(data[0].quote?.isStale, false);
  });

  it("calls yesterday's close stale once today's delayed bars should exist", () => {
    const { data } = assembleTickerStrip(
      input({ quotes: [quote({ observedAt: "2026-11-09T20:59:00.000Z" })] }),
    );
    assert.equal(data[0].quote?.isStale, true);
  });

  it("treats a quote with no observed time as stale rather than current", () => {
    const { data } = assembleTickerStrip(input({ quotes: [quote({ observedAt: null })] }));
    assert.equal(data[0].quote?.isStale, true);
  });

  it("allows three missed worker runs, and never less than fifteen minutes", () => {
    assert.equal(stripStaleAfterSeconds(300), 900);
    assert.equal(stripStaleAfterSeconds(600), 1800);
    assert.equal(stripStaleAfterSeconds(60), 900);
  });
});
