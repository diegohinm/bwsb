import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bucketForDte,
  bucketForFilter,
  classifyDuration,
  daysToExpiration,
} from "../optionDuration.service.js";
import { extractPositions } from "../positionExtractor.service.js";
import { buildPortfolio } from "../wsbPortfolioAggregator.service.js";
import { extractBanbets, resolveOutcome } from "../banbetExtractor.service.js";
import type { SocialPostItem } from "../../social/socialData.types.js";

/**
 * The WSB portfolio is a claim about other people's money, so the tests that
 * matter are the ones that pin what we REFUSE to count: a hype post is not a
 * position, an undated price target is not a bet, and an unresolvable deadline
 * is expired rather than lost.
 */

const NOW = new Date("2026-08-01T15:00:00.000Z");

let seq = 0;
function item(overrides: Partial<SocialPostItem> = {}): SocialPostItem {
  seq += 1;
  return {
    id: `p${seq}`,
    provider: "mock",
    source: "mock",
    subreddit: "wallstreetbets",
    type: "post",
    authorHash: `author-${seq}`,
    createdAt: NOW.toISOString(),
    tickers: [],
    sentiment: "positive",
    stance: "bullish",
    confidence: 0.8,
    isScreenshot: false,
    ...overrides,
  };
}

describe("option duration classification", () => {
  it("counts whole calendar days, not 24-hour blocks", () => {
    // 20:00 today and 04:00 tomorrow are 8 hours apart but 0 and 1 DTE.
    const now = new Date("2026-08-01T20:00:00Z");
    assert.equal(daysToExpiration(new Date("2026-08-01T00:00:00Z"), now), 0);
    assert.equal(daysToExpiration(new Date("2026-08-02T04:00:00Z"), now), 1);
  });

  it("uses contiguous buckets with no gaps at the boundaries", () => {
    assert.equal(bucketForDte(0), "zero_dte");
    assert.equal(bucketForDte(1), "weekly");
    assert.equal(bucketForDte(7), "weekly");
    assert.equal(bucketForDte(8), "swing");
    assert.equal(bucketForDte(90), "swing");
    assert.equal(bucketForDte(91), "leaps");
  });

  it("rejects an expired contract instead of calling it 0DTE", () => {
    assert.equal(bucketForDte(-1), null);
    assert.equal(classifyDuration(new Date("2026-07-31T00:00:00Z"), NOW), null);
  });

  it("maps the UI filter vocabulary onto stored buckets", () => {
    assert.equal(bucketForFilter("0dte"), "zero_dte");
    assert.equal(bucketForFilter("long"), "leaps");
    assert.equal(bucketForFilter("all"), null);
  });
});

describe("position extraction — what does NOT count", () => {
  it("ignores hype with no stated position", () => {
    const positions = extractPositions(
      item({ title: "NVDA to the moon 🚀", text: "AMD is going to rip too" }),
      NOW,
    );
    assert.deepEqual(positions, []);
  });

  it("ignores an option with no expiration", () => {
    // Without a date the contract cannot be bucketed, so it is not a row.
    const positions = extractPositions(item({ text: "grabbed some NVDA 215c" }), NOW);
    assert.deepEqual(positions, []);
  });

  it("ignores an already-expired contract", () => {
    const positions = extractPositions(
      item({ text: "my MU 350c 2026-07-01 got destroyed" }),
      NOW,
    );
    assert.deepEqual(positions, []);
  });

  it("ignores items with no attributable author", () => {
    const positions = extractPositions(
      item({ authorHash: undefined, text: "100 shares of NVDA" }),
      NOW,
    );
    assert.deepEqual(positions, []);
  });

  it("does not turn ordinary words next to a number into holdings", () => {
    // Caught on real ingested data: "100 shares of the float" produced
    // positions in THE and FLOAT. A bare word must be a recognized symbol.
    const positions = extractPositions(
      item({ text: "they bought 100 shares of the float and 50 shares of it" }),
      NOW,
    );
    assert.deepEqual(
      positions.map((p) => (p.kind === "stock" ? p.ticker : p.underlying)),
      [],
    );
  });

  it("accepts a cashtag the allowlist has not caught up with", () => {
    const [position] = extractPositions(item({ text: "grabbed 40 shares of $ZZZZ" }), NOW);
    assert.equal(position.kind, "stock");
    if (position.kind !== "stock") return;
    assert.equal(position.ticker, "ZZZZ");
  });

  it("accepts a bare symbol the upstream extractor recognized", () => {
    const [position] = extractPositions(
      item({ tickers: ["NVDA"], text: "bought 100 shares of NVDA" }),
      NOW,
    );
    if (position.kind !== "stock") throw new Error("expected a stock");
    assert.equal(position.ticker, "NVDA");
  });

  it("does not read a plain number as a strike", () => {
    const positions = extractPositions(
      item({ text: "NVDA is up 215 points since January 2026-12-18" }),
      NOW,
    );
    assert.equal(positions.filter((p) => p.kind === "option").length, 0);
  });
});

describe("position extraction — what counts", () => {
  it("reads an option contract with size and expiration", () => {
    const [position] = extractPositions(
      item({ text: "bought 150x MU $350 C 2027-03-19, see you at retirement" }),
      NOW,
    );
    assert.equal(position.kind, "option");
    if (position.kind !== "option") return;
    assert.equal(position.underlying, "MU");
    assert.equal(position.optionType, "call");
    assert.equal(position.strike, 350);
    assert.equal(position.contracts, 150);
    assert.equal(position.durationBucket, "leaps");
    assert.equal(position.verificationLevel, "extracted");
  });

  it("treats a put as a bearish position regardless of post tone", () => {
    const [position] = extractPositions(
      item({ stance: "bullish", text: "loaded SPY 735p 2026-08-15 lets goooo" }),
      NOW,
    );
    if (position.kind !== "option") throw new Error("expected an option");
    assert.equal(position.optionType, "put");
    assert.equal(position.bullish, false);
  });

  it("marks a broker screenshot as stronger evidence", () => {
    const [position] = extractPositions(
      item({ isScreenshot: true, text: "NVDA $215 C 2026-09-18" }),
      NOW,
    );
    assert.equal(position.verificationLevel, "screenshot");
  });

  it("reads an explicit share count", () => {
    const [position] = extractPositions(item({ text: "picked up 250 shares of $MU" }), NOW);
    assert.equal(position.kind, "stock");
    if (position.kind !== "stock") return;
    assert.equal(position.ticker, "MU");
    assert.equal(position.shares, 250);
    assert.equal(position.verificationLevel, "extracted");
  });

  it("records a sizeless declaration as text_only with no size", () => {
    const [position] = extractPositions(item({ text: "I'm long $INTC and staying long" }), NOW);
    if (position.kind !== "stock") throw new Error("expected a stock");
    assert.equal(position.verificationLevel, "text_only");
    assert.equal(position.shares, 0);
  });
});

describe("portfolio aggregation", () => {
  const positions = [
    ...extractPositions(item({ text: "100x MU $350 C 2027-03-19" }), NOW),
    ...extractPositions(item({ text: "50x MU $350 C 2027-03-19" }), NOW),
    ...extractPositions(item({ text: "bought 200 shares of NVDA" }), NOW),
    ...extractPositions(item({ text: "I'm long $NVDA" }), NOW),
  ];

  it("rolls contracts up per contract and counts distinct holders", () => {
    const { options } = buildPortfolio(positions);
    assert.equal(options.length, 1);
    assert.equal(options[0].quantity, 150);
    assert.equal(options[0].holders, 2);
    // Notional: 150 contracts × 100 × $350.
    assert.equal(options[0].estimatedValue, 150 * 100 * 350);
  });

  it("values stock only when a quote exists", () => {
    const priced = buildPortfolio(positions, new Map([["NVDA", 180]]));
    const nvda = priced.stocks.find((s) => s.ticker === "NVDA")!;
    assert.equal(nvda.shares, 200);
    assert.equal(nvda.estimatedValue, 200 * 180);

    const unpriced = buildPortfolio(positions);
    assert.equal(unpriced.stocks.find((s) => s.ticker === "NVDA")!.estimatedValue, null);
  });

  it("counts a text_only declaration as a holder but not as size", () => {
    const { stocks } = buildPortfolio(positions);
    const nvda = stocks.find((s) => s.ticker === "NVDA")!;
    assert.equal(nvda.holders, 2);
    assert.equal(nvda.shares, 200);
  });

  it("keeps allocation shares adding to 100 when there is exposure", () => {
    const { summary } = buildPortfolio(positions, new Map([["NVDA", 180]]));
    const total = summary.optionsPct + summary.stocksPct + summary.cryptoPct;
    assert.ok(Math.abs(total - 100) < 0.2, `allocation summed to ${total}`);
    assert.equal(summary.cryptoPct, 0);
  });

  it("reports 0% allocation rather than a fake split when nothing is priced", () => {
    const textOnly = extractPositions(item({ text: "I'm long $INTC" }), NOW);
    const { summary } = buildPortfolio(textOnly);
    assert.equal(summary.totalExposure, 0);
    assert.equal(summary.optionsPct, 0);
    assert.equal(summary.stocksPct, 0);
  });

  it("never invents crypto holdings", () => {
    const { summary, crypto } = buildPortfolio(positions);
    assert.deepEqual(crypto, []);
    assert.equal(summary.cryptoPct, 0);
  });

  it("counts duration buckets from the option rows", () => {
    const mixed = [
      ...extractPositions(item({ text: "10x SPY $700 C 2026-08-01" }), NOW),
      ...extractPositions(item({ text: "5x QQQ $600 C 2026-08-05" }), NOW),
      ...extractPositions(item({ text: "3x AMD $200 C 2026-10-16" }), NOW),
      ...extractPositions(item({ text: "1x NVDA $300 C 2027-06-18" }), NOW),
    ];
    const { summary } = buildPortfolio(mixed);
    assert.equal(summary.zeroDteCount, 1);
    assert.equal(summary.weeklyCount, 1);
    assert.equal(summary.swingCount, 1);
    assert.equal(summary.leapsCount, 1);
  });
});

describe("banbet extraction", () => {
  it("requires a deadline — an undated target is not a bet", () => {
    assert.deepEqual(extractBanbets(item({ text: "$NVDA hits 300 eventually" })), []);
  });

  it("reads a bull call with a deadline", () => {
    const [bet] = extractBanbets(item({ text: "$NVDA hits $205 by 8/15" }));
    assert.equal(bet.ticker, "NVDA");
    assert.equal(bet.operator, "gte");
    assert.equal(bet.side, "bull");
    assert.equal(bet.targetPrice, 205);
    assert.ok(bet.expiresAt > bet.createdAt);
  });

  it("reads a bear call", () => {
    const [bet] = extractBanbets(item({ text: "$SOXL below $135 in 3 days" }));
    assert.equal(bet.operator, "lte");
    assert.equal(bet.side, "bear");
    assert.equal(bet.targetPrice, 135);
  });

  it("derives a stable id so re-ingesting upserts instead of duplicating", () => {
    const post = item({ text: "$MU to $1000 by 12/19" });
    assert.equal(extractBanbets(post)[0].externalId, extractBanbets(post)[0].externalId);
    assert.ok(extractBanbets(post)[0].externalId.startsWith(post.id));
  });

  it("stores no Reddit handle — identity stays the anonymized hash", () => {
    const [bet] = extractBanbets(item({ authorHash: "hash-1", text: "$MU to $1000 by 12/19" }));
    assert.equal(bet.usernameHash, "hash-1");
    assert.ok(!("displayUsername" in bet));
  });
});

describe("banbet resolution", () => {
  it("scores a bull call from the distance to target", () => {
    assert.deepEqual(resolveOutcome({ operator: "gte", targetPrice: 200 }, 224), {
      status: "won",
      resultPct: 12,
    });
    assert.deepEqual(resolveOutcome({ operator: "gte", targetPrice: 200 }, 176), {
      status: "lost",
      resultPct: -12,
    });
  });

  it("flips the sign for a bear call, where below target is the win", () => {
    const outcome = resolveOutcome({ operator: "lte", targetPrice: 10 }, 7.07);
    assert.equal(outcome?.status, "won");
    assert.ok(outcome!.resultPct > 0, "a won bear call must not read as a loss");
  });

  it("refuses to decide without a price", () => {
    assert.equal(resolveOutcome({ operator: "gte", targetPrice: 200 }, null), null);
  });
});
