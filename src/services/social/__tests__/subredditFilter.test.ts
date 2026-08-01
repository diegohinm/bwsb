import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSubredditPulse } from "../pulseAggregator.service.js";
import { assemblePulseResponse } from "../socialData.assemble.js";
import {
  TRACKED_SUBREDDIT_NAMES,
  normalizeSubreddit,
  parseSubredditFilter,
} from "../subreddits.js";
import type { SocialPostItem } from "../socialData.types.js";

/**
 * The community filter is only real if DESELECTING a community removes it from
 * every number, not just from the list on screen. These tests pin that: an
 * unselected community must be invisible to the overall score, the mention
 * totals, emerging tickers, divergence, the heatmap and top-mentioned.
 *
 * They also pin the parsing contract the route depends on — a hand-edited URL
 * must degrade to a wider selection, never to a 400 or an empty pulse.
 */

const HOUR = 60 * 60 * 1000;
const now = Date.now();

let seq = 0;
function item(
  subreddit: string,
  tickers: string[],
  stance: SocialPostItem["stance"],
  agoHours = 1,
): SocialPostItem {
  seq += 1;
  return {
    id: `i${seq}`,
    provider: "mock",
    source: "mock",
    subreddit,
    type: "post",
    title: `${tickers.join(" ")} thread`,
    text: "body",
    createdAt: new Date(now - agoHours * HOUR).toISOString(),
    tickers,
    sentiment: stance === "bullish" ? "positive" : stance === "bearish" ? "negative" : "neutral",
    stance,
    confidence: 0.8,
    isScreenshot: false,
  };
}

/**
 * WSB + stocks are bullish on NVDA; investing is loudly bearish on it. If the
 * bearish community leaks into a WSB+stocks selection, the divergence rows and
 * the overall score give it away.
 */
const ITEMS: SocialPostItem[] = [
  item("wallstreetbets", ["NVDA"], "bullish", 5),
  item("wallstreetbets", ["NVDA"], "bullish", 4),
  item("wallstreetbets", ["GME"], "bullish", 3),
  item("stocks", ["NVDA"], "bullish", 5),
  item("stocks", ["AAPL"], "neutral", 2),
  item("investing", ["NVDA"], "bearish", 5),
  item("investing", ["NVDA"], "bearish", 4),
  item("investing", ["BRK.B"], "bearish", 3),
  item("options", ["SPY"], "bearish", 2),
];

const PAIR = ["wallstreetbets", "stocks"];

describe("parseSubredditFilter", () => {
  it("normalizes every shape a URL can carry", () => {
    assert.deepEqual(parseSubredditFilter("r/stocks, WALLSTREETBETS ,/r/options/x"), [
      "wallstreetbets",
      "stocks",
    ]);
  });

  it("orders and de-duplicates so equivalent selections are identical", () => {
    assert.deepEqual(
      parseSubredditFilter("stocks,wallstreetbets"),
      parseSubredditFilter("wallstreetbets,stocks,stocks"),
    );
  });

  it("ignores unknown names instead of failing", () => {
    assert.deepEqual(parseSubredditFilter("stocks,notasub,../etc/passwd"), ["stocks"]);
  });

  it("treats an empty or all-invalid filter as no filter", () => {
    assert.equal(parseSubredditFilter(""), undefined);
    assert.equal(parseSubredditFilter(","), undefined);
    assert.equal(parseSubredditFilter("notasub"), undefined);
    assert.equal(parseSubredditFilter(null), undefined);
  });

  it("resolves canonical casing", () => {
    assert.equal(normalizeSubreddit("valueinvesting"), "ValueInvesting");
    assert.equal(normalizeSubreddit("r/SHORTSQUEEZE"), "Shortsqueeze");
    assert.equal(normalizeSubreddit("nope"), null);
  });
});

describe("buildSubredditPulse — community scoping", () => {
  it("lists only the selected communities", () => {
    const { subreddits, heatmap } = buildSubredditPulse(ITEMS, "24h", PAIR);
    assert.deepEqual(
      subreddits.map((s) => s.subreddit).sort(),
      ["r/stocks", "r/wallstreetbets"],
    );
    assert.deepEqual(heatmap.subreddits, ["r/wallstreetbets", "r/stocks"]);
  });

  it("counts mentions only from the selected communities", () => {
    const { subreddits } = buildSubredditPulse(ITEMS, "24h", PAIR);
    const total = subreddits.reduce((s, r) => s + r.mentions, 0);
    // 3 WSB + 2 stocks — the 3 investing and 1 options items are not counted.
    assert.equal(total, 5);
  });

  it("recomputes the overall score from the selected communities only", () => {
    const all = buildSubredditPulse(ITEMS, "24h");
    const pair = buildSubredditPulse(ITEMS, "24h", PAIR);
    const bearOnly = buildSubredditPulse(ITEMS, "24h", ["investing"]);

    // Dropping the bearish communities must move the score up, and a
    // bearish-only selection must land below the all-communities score.
    assert.ok(
      pair.overall.score > all.overall.score,
      `expected ${pair.overall.score} > ${all.overall.score}`,
    );
    assert.ok(
      bearOnly.overall.score < all.overall.score,
      `expected ${bearOnly.overall.score} < ${all.overall.score}`,
    );
  });

  it("derives emerging tickers only from the selected communities", () => {
    const { emergingTickers } = buildSubredditPulse(ITEMS, "24h", PAIR);
    const symbols = emergingTickers.map((e) => e.ticker);
    // SPY (options) and BRK.B (investing) are outside the selection.
    assert.ok(!symbols.includes("SPY"));
    assert.ok(!symbols.includes("BRK.B"));
    assert.ok(symbols.includes("NVDA"));

    // NVDA is in 2 selected communities, not 3 — spread must not count hidden ones.
    const nvda = emergingTickers.find((e) => e.ticker === "NVDA")!;
    assert.equal(nvda.spreadCount, 2);
  });

  it("compares only the selected communities in divergence", () => {
    const all = buildSubredditPulse(ITEMS, "24h");
    // Bullish WSB/stocks vs bearish investing — a real disagreement on NVDA.
    assert.ok(all.divergence.some((d) => d.ticker === "NVDA"));

    const { divergence } = buildSubredditPulse(ITEMS, "24h", PAIR);
    for (const row of divergence) {
      for (const c of row.communities) {
        assert.ok(
          ["r/wallstreetbets", "r/stocks"].includes(c.subreddit),
          `unselected community leaked: ${c.subreddit}`,
        );
      }
    }
    // With the bearish community hidden, NVDA no longer diverges.
    assert.ok(!divergence.some((d) => d.ticker === "NVDA"));
  });

  it("ranks top-mentioned tickers only from the selected communities", () => {
    const { topMentioned } = buildSubredditPulse(ITEMS, "24h", PAIR);
    const nvda = topMentioned.find((t) => t.symbol === "NVDA")!;
    // 3 NVDA items are in scope; the 2 bearish investing ones are not.
    assert.equal(nvda.mentionCount, 3);
    assert.equal(nvda.stance, "bullish");
    assert.ok(!topMentioned.some((t) => t.symbol === "SPY"));
  });

  it("treats a single selection as valid, not as an error", () => {
    const { subreddits, overall } = buildSubredditPulse(ITEMS, "24h", ["wallstreetbets"]);
    assert.equal(subreddits.length, 1);
    assert.equal(subreddits[0].mentions, 3);
    assert.equal(typeof overall.score, "number");
  });

  it("falls back to every tracked community when no filter is given", () => {
    const omitted = buildSubredditPulse(ITEMS, "24h");
    const empty = buildSubredditPulse(ITEMS, "24h", []);
    assert.equal(omitted.subreddits.length, TRACKED_SUBREDDIT_NAMES.length);
    assert.deepEqual(empty.overall, omitted.overall);
  });

  it("matches stored rows whose casing drifted from the canonical name", () => {
    const drifted = [item("WallStreetBets", ["NVDA"], "bullish", 2)];
    const { subreddits } = buildSubredditPulse(drifted, "24h", ["wallstreetbets"]);
    assert.equal(subreddits[0].subreddit, "r/wallstreetbets");
    assert.equal(subreddits[0].mentions, 1);
  });
});

describe("assemblePulseResponse — filter contract", () => {
  const meta = {
    provider: "mock" as const,
    source: "mock",
    isMock: true,
    updatedAt: new Date(now).toISOString(),
  };

  it("echoes the available and selected communities", () => {
    const res = assemblePulseResponse(ITEMS, "24h", undefined, meta, PAIR);
    assert.deepEqual(res.availableSubreddits, [...TRACKED_SUBREDDIT_NAMES]);
    assert.deepEqual(res.selectedSubreddits, PAIR);
  });

  it("defaults to every community when unfiltered", () => {
    const res = assemblePulseResponse(ITEMS, "24h", undefined, meta);
    assert.deepEqual(res.selectedSubreddits, [...TRACKED_SUBREDDIT_NAMES]);
  });

  it("applies search INSIDE the community filter", () => {
    const res = assemblePulseResponse(ITEMS, "24h", "nvda", meta, PAIR);
    const total = res.subreddits.reduce((s, r) => s + r.mentions, 0);
    // NVDA items: 2 in WSB + 1 in stocks. The 2 in investing are filtered out by
    // the community selection, and GME/AAPL by the query.
    assert.equal(total, 3);
    assert.deepEqual(
      res.subreddits.filter((s) => s.mentions > 0).map((s) => s.subreddit).sort(),
      ["r/stocks", "r/wallstreetbets"],
    );
  });
});
