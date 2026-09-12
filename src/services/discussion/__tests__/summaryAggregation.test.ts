import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { env } from "../../../config/env.js";
import {
  computeHotTickers,
  mentionWindows,
  minimumHotMentions,
  resolveWindow,
  type MentionCounts,
} from "../discussionSummary.service.js";

/**
 * The window arithmetic Top Tickers and Hot Tickers are counted over, and the
 * guards that stop hotness degenerating into noise.
 *
 * The SQL needs a database. Everything that decides what the SQL is asked —
 * which buckets, over what span, compared against what — is pure and lives here,
 * because an error in it produces a ranking that is wrong in a way no reader
 * could detect.
 */

const counts = (entries: Record<string, number>): MentionCounts =>
  new Map(
    Object.entries(entries).map(([symbol, mentions]) => [
      symbol,
      { mentions, bullish: 0, neutral: mentions, bearish: 0 },
    ]),
  );

describe("bucket-aligned mention windows", () => {
  const window = resolveWindow({ range: "1h", now: new Date("2026-09-11T15:07:42.000Z") });

  it("leaves the windows untouched when aggregations are off", () => {
    const raw = mentionWindows(window, false);
    assert.equal(raw.currentFrom.toISOString(), window.from.toISOString());
    assert.equal(raw.currentTo.toISOString(), window.to.toISOString());
    assert.equal(raw.previousFrom.toISOString(), window.previousFrom.toISOString());
  });

  it("anchors the current window to the END of the bucket in progress", () => {
    // 15:07:42 sits in the bucket starting 15:05, which ends at 15:10 — so "the
    // last hour" still contains what was said a minute ago.
    const aligned = mentionWindows(window, true);
    assert.equal(aligned.currentTo.toISOString(), "2026-09-11T15:10:00.000Z");
    assert.equal(aligned.currentFrom.toISOString(), "2026-09-11T14:10:00.000Z");
  });

  it("makes the comparison window immediately precede the current one", () => {
    const aligned = mentionWindows(window, true);
    assert.equal(aligned.previousTo.toISOString(), aligned.currentFrom.toISOString());
    assert.equal(aligned.previousFrom.toISOString(), "2026-09-11T13:10:00.000Z");
  });

  it("gives both windows the same duration — the premise of every growth figure", () => {
    for (const range of ["1h", "6h", "24h", "7d"] as const) {
      const resolved = resolveWindow({ range, now: new Date("2026-09-11T15:07:42.000Z") });
      const aligned = mentionWindows(resolved, true);

      const current = aligned.currentTo.getTime() - aligned.currentFrom.getTime();
      const previous = aligned.previousTo.getTime() - aligned.previousFrom.getTime();
      assert.equal(current, previous, `${range} windows differ in length`);
    }
  });

  it("covers a whole number of five-minute buckets on every fixed range", () => {
    const bucketMs = 5 * 60_000;
    for (const range of ["1h", "6h", "24h", "7d", "30d"] as const) {
      const resolved = resolveWindow({ range, now: new Date("2026-09-11T15:07:42.000Z") });
      const aligned = mentionWindows(resolved, true);

      assert.equal(aligned.currentFrom.getTime() % bucketMs, 0, `${range} start unaligned`);
      assert.equal(aligned.currentTo.getTime() % bucketMs, 0, `${range} end unaligned`);
    }
  });
});

describe("the hot-ticker volume floor", () => {
  it("reproduces the original curve at the default setting", () => {
    // The knob was added without changing what it describes. If this fails,
    // HOT_TICKERS_MIN_MENTIONS has been retuned — which is allowed, but is a
    // product decision rather than a refactor.
    if (env.HOT_TICKERS_MIN_MENTIONS !== 5) return;

    assert.equal(minimumHotMentions(1), 2);
    assert.equal(minimumHotMentions(6), 3);
    assert.equal(minimumHotMentions(24), 5);
    assert.equal(minimumHotMentions(24 * 7), 10);
    assert.equal(minimumHotMentions(24 * 30), 20);
  });

  it("never makes a short window stricter than a long one", () => {
    const hours = [1, 6, 24, 24 * 7, 24 * 30];
    const floors = hours.map(minimumHotMentions);
    for (let i = 1; i < floors.length; i += 1) {
      assert.ok(floors[i] >= floors[i - 1], `floor fell from ${floors[i - 1]} to ${floors[i]}`);
    }
  });
});

describe("hotness ranking", () => {
  const floor = 5;

  it("refuses a low-volume symbol however large its percentage growth", () => {
    // 1 → 3 is +200% and is exactly the noise the floor exists to exclude.
    const hot = computeHotTickers(counts({ NOISE: 3 }), counts({ NOISE: 1 }), floor, 10);
    assert.deepEqual(hot, []);
  });

  it("ranks a real surge above a bigger but flat symbol", () => {
    const current = counts({ SURGE: 40, STEADY: 500 });
    const previous = counts({ SURGE: 5, STEADY: 480 });

    const hot = computeHotTickers(current, previous, floor, 10);
    assert.equal(hot[0].symbol, "SURGE");
  });

  it("reports NEW rather than an infinite percentage when the baseline is zero", () => {
    const hot = computeHotTickers(counts({ FRESH: 30 }), counts({}), floor, 10);
    assert.equal(hot[0].isNew, true);
    assert.equal(hot[0].growthPercent, null);
    assert.equal(hot[0].previousMentions, 0);
  });

  it("excludes a symbol that is not accelerating at all", () => {
    const hot = computeHotTickers(counts({ FADING: 20 }), counts({ FADING: 60 }), floor, 10);
    assert.deepEqual(hot, []);
  });

  it("does not collapse into the volume ranking when every baseline is zero", () => {
    // Uncapped, a zero baseline makes the growth factor equal the volume, and
    // the hot list comes out in the same order as the top list — which is what
    // the growth cap exists to prevent.
    const current = counts({ BIG: 1_000, SMALL: 30 });
    const hot = computeHotTickers(current, counts({}), floor, 10);

    assert.equal(hot.length, 2);

    // Both hit the same growth cap, so only the log-scaled volume separates
    // them. Uncapped, the growth factor would equal the volume and the score
    // would be log1p(n)×n — which spreads these two by a factor of about 67.
    const capped = hot[0].hotScore / hot[1].hotScore;
    const uncapped = (Math.log1p(1_000) * 1_000) / (Math.log1p(30) * 30);
    assert.ok(capped < 3, `capped spread was ${capped}`);
    assert.ok(uncapped > 20, "the uncapped spread is what the cap exists to bound");
  });
});
