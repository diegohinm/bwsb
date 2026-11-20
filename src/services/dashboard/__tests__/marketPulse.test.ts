import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredMarketPulse } from "../../../repositories/marketPulse.repository.js";
import {
  assembleMarketPulse,
  computePulseScore,
  FORMULA_VERSION,
  MIN_CLASSIFIED_MENTIONS,
  pulseBand,
  pulseStaleAfterSeconds,
  pulseTone,
  stanceShares,
} from "../marketPulse.service.js";

/**
 * The Market Pulse read contract.
 *
 * The formula, the label bands and everything the panel SAYS are pure and
 * tested here with the stored row and the clock passed in. The rule every case
 * defends: the score, label and description are arithmetic over stored counts —
 * nothing is filled in when the counts cannot support it.
 */

const NOW = new Date("2026-11-10T16:00:00.000Z");
const SNAPSHOT = "2026-11-10T15:58:00.000Z";

function stored(overrides: Partial<StoredMarketPulse> = {}): StoredMarketPulse {
  return {
    timeframe: "24h",
    windowStart: "2026-11-09T15:58:00.000Z",
    windowEnd: SNAPSHOT,
    score: 60,
    bullishCount: 50,
    neutralCount: 30,
    bearishCount: 20,
    unclassifiedCount: 4,
    mentionCount: 104,
    itemCount: 96,
    postCount: 21,
    commentCount: 75,
    tickerCount: 37,
    subreddits: ["wallstreetbets"],
    provider: "arctic_shift",
    excludedItemCount: 0,
    minClassifiedMentions: MIN_CLASSIFIED_MENTIONS,
    formulaVersion: FORMULA_VERSION,
    latestMentionAt: "2026-11-10T15:51:12.000Z",
    snapshotAt: SNAPSHOT,
    ...overrides,
  };
}

function assemble(snapshot: StoredMarketPulse | null, staleAfterSeconds = 900) {
  return assembleMarketPulse({ timeframe: "24h", snapshot, now: NOW, staleAfterSeconds });
}

describe("computePulseScore — the formula", () => {
  it("is 50 + 50 × (bullish − bearish) ÷ classified, rounded", () => {
    // net = (50 − 20) / 100 = 0.30 → 50 + 15 = 65
    assert.deepEqual(
      computePulseScore({ bullish: 50, neutral: 30, bearish: 20, unclassified: 999 }),
      { score: 65, netSentiment: 30, classified: 100 },
    );
  });

  it("spans exactly 0..100 and centres a balanced crowd on 50", () => {
    assert.equal(computePulseScore({ bullish: 40, neutral: 0, bearish: 0, unclassified: 0 }).score, 100);
    assert.equal(computePulseScore({ bullish: 0, neutral: 0, bearish: 40, unclassified: 0 }).score, 0);
    assert.equal(computePulseScore({ bullish: 20, neutral: 0, bearish: 20, unclassified: 0 }).score, 50);
    assert.equal(computePulseScore({ bullish: 0, neutral: 40, bearish: 0, unclassified: 0 }).score, 50);
  });

  it("lets neutral mentions dilute the tilt toward 50", () => {
    const tight = computePulseScore({ bullish: 30, neutral: 0, bearish: 10, unclassified: 0 }).score;
    const diluted = computePulseScore({ bullish: 30, neutral: 60, bearish: 10, unclassified: 0 }).score;
    assert.equal(tight, 75);
    assert.equal(diluted, 60);
  });

  it("keeps unclassified mentions out of the denominator", () => {
    const a = computePulseScore({ bullish: 30, neutral: 10, bearish: 0, unclassified: 0 });
    const b = computePulseScore({ bullish: 30, neutral: 10, bearish: 0, unclassified: 500 });
    assert.deepEqual(a, b);
  });

  it("publishes NO score below the minimum sample — never a neutral-looking 50", () => {
    const thin = computePulseScore({ bullish: 20, neutral: 5, bearish: 4, unclassified: 50 });
    assert.equal(thin.classified, 29);
    assert.equal(thin.score, null);
    assert.equal(thin.netSentiment, null);

    const none = computePulseScore({ bullish: 0, neutral: 0, bearish: 0, unclassified: 0 });
    assert.equal(none.score, null);
  });

  it("is reproducible: the same counts always give the same score", () => {
    const counts = { bullish: 21, neutral: 81, bearish: 13, unclassified: 0 };
    assert.deepEqual(computePulseScore(counts), computePulseScore({ ...counts }));
    assert.equal(computePulseScore(counts).score, 53); // 50 + 50 × 8/115 = 53.48
  });
});

describe("pulseBand / pulseTone — derived from the visible score", () => {
  it("uses the ticker pages' net-sentiment thresholds (net = 2 × (score − 50))", () => {
    const cases: Array<[number, string]> = [
      [100, "Strong Bullish"],
      [75, "Strong Bullish"],
      [74, "Bullish"],
      [60, "Bullish"],
      [59, "Mixed"],
      [50, "Mixed"],
      [41, "Mixed"],
      [40, "Bearish"],
      [26, "Bearish"],
      [25, "Strong Bearish"],
      [0, "Strong Bearish"],
    ];
    for (const [score, band] of cases) assert.equal(pulseBand(score), band, `score ${score}`);
  });

  it("colours only directional bands", () => {
    assert.equal(pulseTone(60), "bullish");
    assert.equal(pulseTone(59), "neutral");
    assert.equal(pulseTone(41), "neutral");
    assert.equal(pulseTone(40), "bearish");
  });
});

describe("stanceShares", () => {
  it("always sums to 100", () => {
    for (const c of [
      { bullish: 1, neutral: 1, bearish: 1, unclassified: 0 },
      { bullish: 101, neutral: 0, bearish: 99, unclassified: 0 },
      { bullish: 21, neutral: 81, bearish: 13, unclassified: 0 },
    ]) {
      const s = stanceShares(c)!;
      assert.equal(s.bullish + s.neutral + s.bearish, 100, JSON.stringify(c));
    }
  });

  it("is null — not 0/0/0 — when nothing was classified", () => {
    assert.equal(stanceShares({ bullish: 0, neutral: 0, bearish: 0, unclassified: 7 }), null);
  });
});

describe("assembleMarketPulse", () => {
  it("serves a fresh real snapshot with a label and description built from its counts", () => {
    const r = assemble(stored());
    assert.equal(r.status, "ok");
    assert.equal(r.isStale, false);
    assert.equal(r.score, 60);
    assert.equal(r.label, "Bullish Pulse");
    assert.equal(r.tone, "bullish");
    assert.equal(r.netSentiment, 30);
    assert.deepEqual(r.shares, { bullish: 50, neutral: 30, bearish: 20 });
    assert.equal(
      r.description,
      "50% bullish · 20% bearish · 30% neutral across 100 ticker mentions on Reddit in the last 24h.",
    );
    assert.equal(r.snapshotAt, SNAPSHOT);
    assert.equal(r.latestMentionAt, "2026-11-10T15:51:12.000Z");
    assert.deepEqual(r.window, { start: "2026-11-09T15:58:00.000Z", end: SNAPSHOT });
    assert.equal(r.counts?.classified, 100);
    assert.equal(r.counts?.unclassified, 4);
    assert.equal(r.source.provider, "arctic_shift");
    assert.equal(r.formula.version, FORMULA_VERSION);
    assert.ok(r.formula.expression?.includes("bullish − bearish"));
    assert.equal(r.warning, null);
  });

  it("serves the STORED score, not one recomputed under today's code", () => {
    // A row the worker wrote is the published figure; the API must not quietly
    // replace it (65 by today's formula for these counts).
    const r = assemble(stored({ score: 64 }));
    assert.equal(r.score, 64);
    assert.equal(r.label, "Bullish Pulse");
  });

  it("labels a mixed crowd honestly", () => {
    const r = assemble(stored({ score: 53, bullishCount: 21, neutralCount: 81, bearishCount: 13 }));
    assert.equal(r.label, "Mixed Pulse");
    assert.equal(r.tone, "neutral");
    assert.match(r.description, /^18% bullish · 11% bearish · 71% neutral across 115 ticker mentions/);
  });

  it("reports an old snapshot as stale, keeping its score and timestamp", () => {
    const old = "2026-11-10T15:00:00.000Z"; // 60 min before NOW, threshold 15 min
    const r = assemble(stored({ snapshotAt: old }));
    assert.equal(r.status, "stale");
    assert.equal(r.isStale, true);
    assert.equal(r.score, 60);
    assert.equal(r.snapshotAt, old);
    assert.match(r.warning ?? "", /has not published a newer snapshot/);
  });

  it("declares an insufficient sample instead of drawing a needle", () => {
    const r = assemble(
      stored({ score: null, bullishCount: 6, neutralCount: 4, bearishCount: 2, unclassifiedCount: 1 }),
    );
    assert.equal(r.status, "insufficient");
    assert.equal(r.score, null);
    assert.equal(r.tone, null);
    assert.equal(r.netSentiment, null);
    assert.equal(r.label, "Not enough data");
    assert.equal(
      r.description,
      `Only 12 classified ticker mentions on Reddit in the last 24h — the pulse needs at least ${MIN_CLASSIFIED_MENTIONS}.`,
    );
    // The counts it DID measure are still reported.
    assert.equal(r.counts?.classified, 12);
    assert.equal(r.snapshotAt, SNAPSHOT);
  });

  it("says when the window held no classified mention at all", () => {
    const r = assemble(
      stored({ score: null, bullishCount: 0, neutralCount: 0, bearishCount: 0, unclassifiedCount: 0, provider: null }),
    );
    assert.equal(r.status, "insufficient");
    assert.equal(r.shares, null);
    assert.match(r.description, /^No classified ticker mentions on Reddit in the last 24h/);
  });

  it("keeps a stale insufficient snapshot insufficient, flagged stale", () => {
    const r = assemble(stored({ score: null, bullishCount: 1, snapshotAt: "2026-11-10T10:00:00.000Z" }));
    assert.equal(r.status, "insufficient");
    assert.equal(r.isStale, true);
    assert.equal(r.score, null);
  });

  it("is empty — no score, no counts, no timestamp — when the worker never published", () => {
    const r = assemble(null);
    assert.equal(r.status, "empty");
    assert.equal(r.score, null);
    assert.equal(r.tone, null);
    assert.equal(r.counts, null);
    assert.equal(r.shares, null);
    assert.equal(r.snapshotAt, null);
    assert.equal(r.window, null);
    assert.equal(r.label, "No pulse yet");
    assert.ok(r.warning);
  });

  it("never serves an out-of-range stored score", () => {
    const r = assemble(stored({ score: 140 }));
    assert.equal(r.score, null);
    assert.equal(r.status, "insufficient");
  });

  it("does not claim today's formula for a row written under another version", () => {
    const r = assemble(stored({ formulaVersion: "stance-net-v0" }));
    assert.equal(r.formula.version, "stance-net-v0");
    assert.equal(r.formula.expression, null);
  });

  it("surfaces excluded demo/unattributed items as a warning", () => {
    const r = assemble(stored({ excludedItemCount: 12 }));
    assert.equal(r.source.excludedItems, 12);
    assert.match(r.warning ?? "", /12 demo or unattributed item\(s\)/);
  });

  it("phrases the window for each timeframe", () => {
    const r = assembleMarketPulse({
      timeframe: "7d",
      snapshot: stored({ timeframe: "7d" }),
      now: NOW,
      staleAfterSeconds: 900,
    });
    assert.match(r.description, /in the last 7 days\.$/);
  });
});

describe("pulseStaleAfterSeconds", () => {
  it("is three missed runs, never under fifteen minutes", () => {
    assert.equal(pulseStaleAfterSeconds(300), 900);
    assert.equal(pulseStaleAfterSeconds(60), 900);
    assert.equal(pulseStaleAfterSeconds(600), 1800);
  });
});
