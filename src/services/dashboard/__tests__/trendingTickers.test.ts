import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredQuote } from "../../../repositories/marketSnapshots.repository.js";
import type { StoredTrendingTicker } from "../../../repositories/socialSnapshots.repository.js";
import type { ListingName } from "../../../repositories/tickers.repository.js";
import { assembleTickerStrip, type AssembleInput } from "../tickerStrip.service.js";
import {
  assembleTrendingTickers,
  competitionRanks,
  displayCompanyName,
} from "../trendingTickers.service.js";

/**
 * The Dashboard Trending Tickers read contract.
 *
 * The table is the strip's ranking (same rows, same prices, same staleness)
 * plus a rank and a company name. Every case pins one way it could otherwise
 * invent something: a curated symbol, a name nobody published, a price from the
 * snapshot instead of the quotes table, or a full-looking table over nothing.
 */

// Tue 2026-11-10 11:00 ET — inside a regular session.
const NOW = new Date("2026-11-10T16:00:00.000Z");
const SNAPSHOT = "2026-11-10T15:58:00.000Z";

function row(overrides: Partial<StoredTrendingTicker> = {}): StoredTrendingTicker {
  return {
    symbol: "NVDA",
    mentionCount: 41,
    stance: "bullish",
    price: 999.99, // the snapshot's own price — must NOT be what the table serves
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

function listing(symbol: string, listingName: string, source = "NASDAQ_TRADER_NASDAQ_LISTED"): ListingName {
  return { symbol, listingName, source };
}

function stripInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    timeframe: "24h",
    limit: 5,
    rows: [row()],
    quotes: [quote()],
    now: NOW,
    marketOpen: true,
    staleAfterSeconds: 900,
    ...overrides,
  };
}

function assemble(overrides: Partial<AssembleInput> = {}, names: ListingName[] = []) {
  return assembleTrendingTickers(assembleTickerStrip(stripInput(overrides)), names);
}

describe("trending tickers — real data", () => {
  it("serves the stored ranking with directory names and stored delayed quotes", () => {
    const { data, meta } = assemble({}, [listing("NVDA", "NVIDIA Corporation - Common Stock")]);

    assert.equal(meta.status, "ok");
    assert.equal(meta.snapshotAt, SNAPSHOT);
    assert.equal(meta.social.provider, "arctic_shift");
    assert.deepEqual(data, [
      {
        rank: 1,
        symbol: "NVDA",
        companyName: "NVIDIA Corporation",
        listingName: "NVIDIA Corporation - Common Stock",
        mentionCount: 41,
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
    assert.deepEqual(meta.names, {
      sources: ["NASDAQ_TRADER_NASDAQ_LISTED"],
      named: 1,
      missing: 0,
    });
    assert.equal(meta.market.displayMode, "delayed");
    assert.equal(meta.warning, null);
  });

  it("ranks by the worker's mention counts — whatever symbols Reddit is mentioning", () => {
    const rows = [
      row({ symbol: "NVDA", mentionCount: 41 }),
      row({ symbol: "SPY", mentionCount: 12 }),
      row({ symbol: "GOOGL", mentionCount: 6 }),
      row({ symbol: "CRWV", mentionCount: 4 }),
      row({ symbol: "PR", mentionCount: 4 }),
      row({ symbol: "RKLB", mentionCount: 4 }),
    ];
    const { data } = assemble({ rows });
    assert.deepEqual(
      data.map((d) => [d.rank, d.symbol, d.mentionCount]),
      [
        [1, "NVDA", 41],
        [2, "SPY", 12],
        [3, "GOOGL", 6],
        [4, "CRWV", 4],
        [4, "PR", 4],
      ],
    );
  });

  it("uses the same rows and prices as the ticker strip", () => {
    const rows = [row({ symbol: "NVDA" }), row({ symbol: "SPY", mentionCount: 12 })];
    const quotes = [quote(), quote({ symbol: "SPY", price: 738.49, changePct: 0.04 })];
    const strip = assembleTickerStrip(stripInput({ rows, quotes }));
    const table = assembleTrendingTickers(strip, []);
    assert.deepEqual(
      table.data.map((d) => [d.symbol, d.mentionCount, d.quote]),
      strip.data.map((d) => [d.symbol, d.mentionCount, d.quote]),
    );
  });

  it("never serves the snapshot's frozen price", () => {
    const { data } = assemble();
    assert.equal(data[0].quote?.price, 196.1);
    assert.notEqual(data[0].quote?.price, 999.99);
  });

  it("never labels a stored quote real-time", () => {
    const { data, meta } = assemble({ quotes: [quote({ displayMode: "realtime" })] });
    assert.equal(data[0].quote?.displayMode, "delayed");
    assert.equal(meta.market.displayMode, "delayed");
  });
});

describe("trending tickers — no fabricated names, prices or rows", () => {
  it("leaves the name unknown when no listing directory has the symbol", () => {
    const { data, meta } = assemble({}, []);
    assert.equal(data[0].companyName, null);
    assert.equal(data[0].listingName, null);
    assert.deepEqual(meta.names, { sources: [], named: 0, missing: 1 });
  });

  it("ships a symbol without a stored quote with quote: null, not a fixture price", () => {
    const rows = [row({ symbol: "NVDA" }), row({ symbol: "CRWV", mentionCount: 4 })];
    const { data, meta } = assemble({ rows }, [
      listing("CRWV", "CoreWeave, Inc. - Class A Common Stock"),
    ]);
    const crwv = data.find((d) => d.symbol === "CRWV");
    assert.ok(crwv);
    assert.equal(crwv.quote, null);
    assert.equal(crwv.companyName, "CoreWeave, Inc.");
    assert.equal(meta.market.missing, 1);
    assert.match(meta.warning ?? "", /no stored quote/);
  });

  it("refuses mock quotes and mock-provider rows exactly like the strip", () => {
    const rows = [row({ symbol: "FAKE", providerSocial: "mock" }), row({ symbol: "NVDA" })];
    const { data } = assemble({
      rows,
      quotes: [quote({ isMock: true, provider: "mock", displayMode: "mock" })],
    });
    assert.deepEqual(
      data.map((d) => d.symbol),
      ["NVDA"],
    );
    assert.equal(data[0].quote, null);
    assert.equal(data[0].rank, 1, "a dropped row does not leave a gap in the ranking");
  });

  it("contains no curated dashboard symbols unless the ranking holds them", () => {
    const { data } = assemble({ rows: [row({ symbol: "RKLB", mentionCount: 3 })], quotes: [] });
    assert.deepEqual(
      data.map((d) => d.symbol),
      ["RKLB"],
    );
  });
});

describe("trending tickers — empty and stale", () => {
  it("is empty, with no names, when the worker never published", () => {
    const { data, meta } = assemble({ rows: [], quotes: [] }, [listing("NVDA", "NVIDIA Corporation")]);
    assert.deepEqual(data, []);
    assert.equal(meta.status, "empty");
    assert.equal(meta.snapshotAt, null);
    assert.match(meta.warning ?? "", /not published/);
    assert.deepEqual(meta.names, { sources: [], named: 0, missing: 0 });
  });

  it("is empty when every stored row is unverifiable", () => {
    const { data, meta } = assemble({ rows: [row({ providerSocial: "mock" })] });
    assert.deepEqual(data, []);
    assert.equal(meta.status, "empty");
    assert.equal(meta.snapshotAt, SNAPSHOT);
  });

  it("reports an old ranking as stale with its snapshot time, and still serves it", () => {
    const old = "2026-11-10T14:00:00.000Z";
    const { data, meta } = assemble({ rows: [row({ snapshotAt: old })] });
    assert.equal(meta.status, "stale");
    assert.equal(meta.snapshotAt, old);
    assert.equal(data.length, 1);
  });

  it("flags a price from an earlier session and keeps its date", () => {
    const { data, meta } = assemble({
      quotes: [quote({ observedAt: "2026-07-27T23:49:00.000Z", session: "after_hours" })],
    });
    assert.equal(data[0].quote?.isStale, true);
    assert.equal(data[0].quote?.observedAt, "2026-07-27T23:49:00.000Z");
    assert.equal(meta.market.stale, 1);
  });
});

describe("competitionRanks", () => {
  it("shares a rank between equal counts and skips the places they occupy", () => {
    assert.deepEqual(competitionRanks([41, 12, 6, 4, 4]), [1, 2, 3, 4, 4]);
    assert.deepEqual(competitionRanks([5, 5, 5, 2]), [1, 1, 1, 4]);
    assert.deepEqual(competitionRanks([]), []);
  });
});

describe("displayCompanyName", () => {
  const cases: Array<[string, string]> = [
    ["NVIDIA Corporation - Common Stock", "NVIDIA Corporation"],
    ["Alphabet Inc. - Class A Common Stock", "Alphabet Inc."],
    ["Alphabet Inc. - Class C Capital Stock", "Alphabet Inc."],
    ["Nebius Group N.V. - Class A Ordinary Shares", "Nebius Group N.V."],
    ["BP p.l.c. Common Stock", "BP p.l.c."],
    ["Hims & Hers Health, Inc. Class A Common Stock", "Hims & Hers Health, Inc."],
    ["Permian Resources Corporation Class A Common Stock", "Permian Resources Corporation"],
    ["Eversource Energy (D/B/A) Common Stock", "Eversource Energy"],
    [
      "Global Partners LP Common Units representing Limited Partner Interests",
      "Global Partners LP",
    ],
    ["State Street SPDR S&P 500 ETF Trust", "State Street SPDR S&P 500 ETF Trust"],
    ["Grayscale Bitcoin Mini Trust (BTC)", "Grayscale Bitcoin Mini Trust (BTC)"],
    ["Clockwise U.S. Core Equity ETF", "Clockwise U.S. Core Equity ETF"],
  ];

  for (const [published, shown] of cases) {
    it(`"${published}" → "${shown}"`, () => {
      assert.equal(displayCompanyName(published), shown);
    });
  }

  it("keeps a dash that is part of the company's own name", () => {
    assert.equal(displayCompanyName("Coca-Cola Company (The) Common Stock"), "Coca-Cola Company (The)");
    assert.equal(displayCompanyName("Foo - Bar Holdings"), "Foo - Bar Holdings");
  });

  it("returns the published name rather than an empty string", () => {
    assert.equal(displayCompanyName("Common Stock"), "Common Stock");
  });
});
