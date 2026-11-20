import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredQuote } from "../../repositories/marketSnapshots.repository.js";
import type { SocialPostItem } from "../../services/social/socialData.types.js";
import { buildTrendingRows, rankTrending, realSocialItems } from "../refreshTickerStrip.job.js";

/**
 * The worker half of the ticker strip: what gets counted as a mention and what
 * gets recorded as a price. Pure — the job's database reads are passed in.
 */

let seq = 0;
function item(overrides: Partial<SocialPostItem> = {}): SocialPostItem {
  seq += 1;
  return {
    id: `t${seq}`,
    provider: "arctic_shift",
    source: "arctic_shift",
    subreddit: "wallstreetbets",
    type: "comment",
    createdAt: "2026-11-10T15:00:00.000Z",
    tickers: ["NVDA"],
    sentiment: "neutral",
    stance: "neutral",
    confidence: 0.5,
    isScreenshot: false,
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
    change: null,
    changePct: -5.11,
    volume: null,
    timestamp: "2026-11-10T15:44:00.000Z",
    observedAt: "2026-11-10T15:44:00.000Z",
    isMock: false,
    isDelayed: true,
    delayMinutes: 15,
    storedAt: "2026-11-10T15:59:00.000Z",
    ...overrides,
  };
}

describe("refreshTickerStrip — counting", () => {
  it("never counts mock-provider content as a mention", () => {
    const items = [
      item({ tickers: ["NVDA"] }),
      item({ provider: "mock", tickers: ["FAKE"] }),
      item({ provider: "mock", tickers: ["FAKE"] }),
    ];
    assert.equal(realSocialItems(items).length, 1);

    const ranking = rankTrending(items, "24h");
    assert.deepEqual(
      ranking.top.map((t) => t.symbol),
      ["NVDA"],
    );
  });

  it("ranks nothing when only mock content exists — no demo tape is produced", () => {
    const ranking = rankTrending([item({ provider: "mock" })], "24h");
    assert.deepEqual(ranking.top, []);
    assert.deepEqual(buildTrendingRows(ranking, [quote()], "24h"), []);
  });

  it("ranks by mention volume across real content", () => {
    const items = [
      item({ tickers: ["SPY"] }),
      item({ tickers: ["NVDA"] }),
      item({ tickers: ["NVDA"] }),
    ];
    const rows = buildTrendingRows(rankTrending(items, "24h"), [], "24h");
    assert.deepEqual(
      rows.map((r) => [r.symbol, r.mentionCount]),
      [
        ["NVDA", 2],
        ["SPY", 1],
      ],
    );
  });
});

describe("refreshTickerStrip — prices and provenance", () => {
  it("records a real quote with its provider", () => {
    const [row] = buildTrendingRows(rankTrending([item()], "24h"), [quote()], "24h");
    assert.equal(row.price, 196.1);
    assert.equal(row.changePct, -5.11);
    assert.equal(row.providerMarket, "databento");
    assert.equal(row.providerSocial, "arctic_shift");
    assert.equal(row.isMock, false);
  });

  it("records a missing quote as unknown — not as demo data", () => {
    const [row] = buildTrendingRows(rankTrending([item()], "24h"), [], "24h");
    assert.equal(row.price, null);
    assert.equal(row.changePct, null);
    assert.equal(row.providerMarket, "none");
    assert.equal(row.isMock, false);
  });

  it("never attaches a mock quote", () => {
    const [row] = buildTrendingRows(
      rankTrending([item()], "24h"),
      [quote({ isMock: true, provider: "mock", price: 123.45 })],
      "24h",
    );
    assert.equal(row.price, null);
    assert.equal(row.providerMarket, "none");
  });

  it("names every real social provider that contributed", () => {
    const items = [item({ provider: "mindcase" }), item({ provider: "arctic_shift" })];
    const [row] = buildTrendingRows(rankTrending(items, "24h"), [], "24h");
    assert.equal(row.providerSocial, "arctic_shift+mindcase");
  });
});
