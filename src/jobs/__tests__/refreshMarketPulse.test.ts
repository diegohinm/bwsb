import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MentionGroup } from "../../repositories/marketPulse.repository.js";
import {
  FORMULA_VERSION,
  MIN_CLASSIFIED_MENTIONS,
} from "../../services/dashboard/marketPulse.service.js";
import {
  buildMarketPulseSnapshot,
  isRealProvider,
  tallyMentionGroups,
} from "../refreshMarketPulse.job.js";

/**
 * The worker half of the Market Pulse: which stored mentions are counted, how
 * their stance is tallied, and what row is written. Pure — the SQL aggregate's
 * groups are passed in.
 */

function group(overrides: Partial<MentionGroup> = {}): MentionGroup {
  return {
    provider: "arctic_shift",
    kind: "comment",
    stance: "neutral",
    mentions: 10,
    items: 9,
    tickers: ["NVDA"],
    subreddits: ["wallstreetbets"],
    newest: "2026-11-10T15:00:00.000Z",
    ...overrides,
  };
}

const WINDOW = {
  timeframe: "24h" as const,
  windowStart: "2026-11-09T16:00:00.000Z",
  windowEnd: "2026-11-10T16:00:00.000Z",
};

describe("isRealProvider", () => {
  it("rejects the mock provider and rows with no provider", () => {
    assert.equal(isRealProvider("arctic_shift"), true);
    assert.equal(isRealProvider("mindcase"), true);
    assert.equal(isRealProvider("mock"), false);
    assert.equal(isRealProvider(null), false);
    assert.equal(isRealProvider("  "), false);
  });
});

describe("tallyMentionGroups", () => {
  it("never counts mock or provider-less content, but records how much was excluded", () => {
    const t = tallyMentionGroups([
      group({ stance: "bullish", mentions: 5, items: 5 }),
      group({ provider: "mock", stance: "bullish", mentions: 500, items: 400, tickers: ["GME"] }),
      group({ provider: null, stance: "bearish", mentions: 70, items: 60, tickers: ["AMC"] }),
    ]);
    assert.deepEqual(t.stance, { bullish: 5, neutral: 0, bearish: 0, unclassified: 0 });
    assert.equal(t.mentions, 5);
    assert.equal(t.tickers, 1);
    assert.equal(t.excludedItems, 460);
    assert.equal(t.provider, "arctic_shift");
  });

  it("files an unknown or missing stance as unclassified — never as neutral", () => {
    const t = tallyMentionGroups([
      group({ stance: null, mentions: 7 }),
      group({ stance: "mixed", mentions: 3 }),
      group({ stance: "neutral", mentions: 2 }),
    ]);
    assert.equal(t.stance.unclassified, 10);
    assert.equal(t.stance.neutral, 2);
    assert.equal(t.mentions, 12);
  });

  it("tolerates stance casing drift in stored rows", () => {
    const t = tallyMentionGroups([group({ stance: "Bullish ", mentions: 4 })]);
    assert.equal(t.stance.bullish, 4);
  });

  it("splits items into posts and comments and unions tickers/subreddits", () => {
    const t = tallyMentionGroups([
      group({ kind: "post", items: 3, mentions: 4, tickers: ["NVDA", "AMD"], subreddits: ["wallstreetbets"] }),
      group({ kind: "comment", items: 8, mentions: 9, tickers: ["nvda", "TSLA"], subreddits: ["stocks"] }),
    ]);
    assert.equal(t.posts, 3);
    assert.equal(t.comments, 8);
    assert.equal(t.items, 11);
    assert.equal(t.tickers, 3); // NVDA, AMD, TSLA
    assert.deepEqual(t.subreddits, ["stocks", "wallstreetbets"]);
  });

  it("reports the newest counted mention, ignoring excluded content", () => {
    const t = tallyMentionGroups([
      group({ newest: "2026-11-10T14:00:00.000Z" }),
      group({ newest: "2026-11-10T15:30:00.000Z", stance: "bullish" }),
      group({ provider: "mock", newest: "2026-11-10T15:59:00.000Z" }),
    ]);
    assert.equal(t.latestMentionAt, "2026-11-10T15:30:00.000Z");
  });

  it("joins multiple real providers into one stable label", () => {
    const t = tallyMentionGroups([group({ provider: "mindcase" }), group({ provider: "arctic_shift" })]);
    assert.equal(t.provider, "arctic_shift+mindcase");
  });

  it("is empty — no provider, no timestamp — over nothing", () => {
    const t = tallyMentionGroups([]);
    assert.equal(t.mentions, 0);
    assert.equal(t.provider, null);
    assert.equal(t.latestMentionAt, null);
  });
});

describe("buildMarketPulseSnapshot", () => {
  it("stores the score WITH every count it came from, under the formula version", () => {
    const row = buildMarketPulseSnapshot({
      ...WINDOW,
      groups: [
        group({ stance: "bullish", mentions: 50, items: 45 }),
        group({ stance: "neutral", mentions: 30, items: 30 }),
        group({ stance: "bearish", mentions: 20, items: 18 }),
        group({ stance: null, mentions: 4, items: 4 }),
      ],
    });
    assert.equal(row.score, 65); // 50 + 50 × 30/100
    assert.equal(row.bullishCount, 50);
    assert.equal(row.neutralCount, 30);
    assert.equal(row.bearishCount, 20);
    assert.equal(row.unclassifiedCount, 4);
    assert.equal(row.mentionCount, 104);
    assert.equal(row.itemCount, 97);
    assert.equal(row.formulaVersion, FORMULA_VERSION);
    assert.equal(row.minClassifiedMentions, MIN_CLASSIFIED_MENTIONS);
    assert.equal(row.windowStart, WINDOW.windowStart);
    assert.equal(row.windowEnd, WINDOW.windowEnd);
    assert.equal(row.provider, "arctic_shift");
  });

  it("records a thin window with a NULL score rather than skipping or guessing", () => {
    const row = buildMarketPulseSnapshot({
      ...WINDOW,
      groups: [group({ stance: "bullish", mentions: MIN_CLASSIFIED_MENTIONS - 1 })],
    });
    assert.equal(row.score, null);
    assert.equal(row.bullishCount, MIN_CLASSIFIED_MENTIONS - 1);
  });

  it("does not let mock content lift a thin real window over the minimum", () => {
    const row = buildMarketPulseSnapshot({
      ...WINDOW,
      groups: [
        group({ stance: "bullish", mentions: 5 }),
        group({ provider: "mock", stance: "bullish", mentions: 1_000, items: 1_000 }),
      ],
    });
    assert.equal(row.score, null);
    assert.equal(row.bullishCount, 5);
    assert.equal(row.excludedItemCount, 1_000);
  });

  it("records an all-mock window as zero real mentions", () => {
    const row = buildMarketPulseSnapshot({
      ...WINDOW,
      groups: [group({ provider: "mock", stance: "bullish", mentions: 80, items: 80 })],
    });
    assert.equal(row.score, null);
    assert.equal(row.mentionCount, 0);
    assert.equal(row.provider, null);
    assert.equal(row.excludedItemCount, 80);
  });
});
