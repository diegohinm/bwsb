import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateYoloScore,
  directionFor,
  expectedMoveFor,
  horizonYears,
  meetsMinimumTargetMove,
  targetTouched,
  type YoloScoreBreakdown,
} from "../yoloScore.service.js";
import { YOLO_SCORE_CONFIG, YOLO_SCORING_VERSION } from "../yoloScore.config.js";

/**
 * The score exists to separate "was this user right?" from "how hard was the
 * call?". Every test here is one way that separation can silently collapse.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CREATED = new Date("2026-09-01T14:30:00.000Z");
const inDays = (n: number) => new Date(CREATED.getTime() + n * DAY_MS);

/** A scorable result, or a failed assertion naming why it was not. */
function score(overrides: {
  entryPrice?: number;
  targetPrice?: number;
  days?: number;
  volatilityAtEntry?: number | null;
  outcome?: "won" | "lost" | "unresolved";
}): YoloScoreBreakdown {
  const result = calculateYoloScore({
    entryPrice: overrides.entryPrice ?? 700,
    targetPrice: overrides.targetPrice ?? 850,
    createdAt: CREATED,
    expiresAt: inDays(overrides.days ?? 14),
    volatilityAtEntry: overrides.volatilityAtEntry === undefined ? 0.4 : overrides.volatilityAtEntry,
    outcome: overrides.outcome ?? "won",
  });
  assert.ok(result.scorable, `expected a scorable bet, got ${JSON.stringify(result)}`);
  return result;
}

describe("target distance", () => {
  /**
   * THE HEADLINE REQUIREMENT. If these two can tie, the leaderboard is just a
   * win-rate table wearing a different hat.
   */
  it("pays far more for a distant target than a near one, all else equal", () => {
    const near = score({ entryPrice: 100, targetPrice: 105 });
    const far = score({ entryPrice: 100, targetPrice: 150 });

    assert.ok(
      far.rawScore > near.rawScore,
      `+50% (${far.rawScore}) must outscore +5% (${near.rawScore})`,
    );
    // Not a rounding-width difference — a different class of claim.
    assert.ok(far.rawScore > near.rawScore * 3, `${far.rawScore} vs ${near.rawScore}`);
    assert.ok(far.difficulty > near.difficulty);
  });

  it("treats a halving and a doubling as the same size of claim", () => {
    // The whole reason distance is a log return. On simple percentages a
    // double reads as +100 and a halving as -50, which would make every DOWN
    // bet structurally cheaper and tilt the board bullish.
    const doubling = score({ entryPrice: 100, targetPrice: 200 });
    const halving = score({ entryPrice: 100, targetPrice: 50 });
    assert.equal(doubling.targetMove, halving.targetMove);
    assert.equal(doubling.rawScore, halving.rawScore);
  });

  it("scales monotonically with distance", () => {
    const scores = [110, 130, 160, 200].map((t) => score({ entryPrice: 100, targetPrice: t }).rawScore);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i]! > scores[i - 1]!, `${scores[i]} must exceed ${scores[i - 1]}`);
    }
  });
});

describe("time", () => {
  it("makes the same target harder when there is less time for it", () => {
    const oneDay = score({ entryPrice: 100, targetPrice: 120, days: 1 });
    const thirtyDays = score({ entryPrice: 100, targetPrice: 120, days: 30 });

    assert.ok(
      oneDay.difficulty > thirtyDays.difficulty,
      `+20% in 1d (${oneDay.difficulty}) must be harder than in 30d (${thirtyDays.difficulty})`,
    );
    assert.ok(oneDay.rawScore > thirtyDays.rawScore);
  });

  it("scales the expected move with the square root of time, not linearly", () => {
    // Four times the horizon is twice the expected move. Linear scaling would
    // make long-dated bets absurdly cheap.
    const oneWeek = expectedMoveFor(0.4, horizonYears(CREATED, inDays(7)));
    const fourWeeks = expectedMoveFor(0.4, horizonYears(CREATED, inDays(28)));
    assert.ok(Math.abs(fourWeeks / oneWeek - 2) < 1e-9, `${fourWeeks / oneWeek}`);
  });
});

describe("volatility", () => {
  /**
   * The point of normalizing: +10% on a sleepy index is a far bigger claim
   * than +10% on something that routinely swings that much in a session.
   */
  it("makes the same move harder on a calm asset than a wild one", () => {
    const calm = score({ entryPrice: 100, targetPrice: 110, days: 7, volatilityAtEntry: 0.12 });
    const wild = score({ entryPrice: 100, targetPrice: 110, days: 7, volatilityAtEntry: 0.9 });

    assert.ok(
      calm.difficulty > wild.difficulty,
      `+10% on sigma=12% (${calm.difficulty}) must beat sigma=90% (${wild.difficulty})`,
    );
    assert.ok(calm.rawScore > wild.rawScore);
  });

  it("puts difficulty at 1 when the target IS the expected move", () => {
    // sigma*sqrt(T) with sigma=0.4 over a year is 0.4 in log terms.
    const oneYear = new Date(CREATED.getTime() + 365 * DAY_MS);
    const target = 100 * Math.exp(0.4);
    const result = calculateYoloScore({
      entryPrice: 100,
      targetPrice: target,
      createdAt: CREATED,
      expiresAt: oneYear,
      volatilityAtEntry: 0.4,
      outcome: "won",
    });
    assert.ok(result.scorable);
    assert.ok(Math.abs(result.difficulty - 1) < 1e-6, `${result.difficulty}`);
    assert.ok(Math.abs(result.rawScore - 100) < 0.01, `${result.rawScore}`);
  });

  /**
   * NEVER INVENT A DIFFICULTY. Substituting a default volatility would assert
   * that the ticker behaves like the index, which is the claim under test.
   */
  it("refuses to score without volatility rather than assuming one", () => {
    for (const bad of [null, 0, -0.3, Number.NaN]) {
      const result = calculateYoloScore({
        entryPrice: 100,
        targetPrice: 150,
        createdAt: CREATED,
        expiresAt: inDays(14),
        volatilityAtEntry: bad as number | null,
        outcome: "won",
      });
      assert.equal(result.scorable, false, `sigma=${bad} must not be scorable`);
      assert.equal((result as { reason: string }).reason, "missing_volatility");
    }
  });
});

describe("win and loss", () => {
  it("adds the full raw score for a win", () => {
    const won = score({ outcome: "won" });
    assert.equal(won.scoreDelta, won.rawScore);
    assert.ok(won.scoreDelta > 0);
  });

  it("subtracts a fraction of the same bet's score for a loss", () => {
    // The spec's worked example: raw 400 loses 100 at the 0.25 multiplier.
    const lost = score({ outcome: "lost" });
    const expected = -lost.rawScore * YOLO_SCORE_CONFIG.lossMultiplier;
    assert.ok(Math.abs(lost.scoreDelta - expected) < 0.01, `${lost.scoreDelta} vs ${expected}`);
    assert.ok(lost.scoreDelta < 0);
  });

  it("charges a losing loud bet more than a losing quiet one", () => {
    // Otherwise firing impossible targets is free.
    const quiet = score({ entryPrice: 100, targetPrice: 105, outcome: "lost" });
    const loud = score({ entryPrice: 100, targetPrice: 300, outcome: "lost" });
    assert.ok(loud.scoreDelta < quiet.scoreDelta, `${loud.scoreDelta} vs ${quiet.scoreDelta}`);
  });

  it("moves nothing while the bet is still running", () => {
    const open = score({ outcome: "unresolved" });
    assert.equal(open.scoreDelta, 0);
    // The potential is still reported, so the UI can preview it.
    assert.ok(open.rawScore > 0);
  });
});

describe("the per-bet cap", () => {
  it("clamps a runaway score and says that it did", () => {
    // Enormous target, almost no time, calm asset.
    const extreme = score({
      entryPrice: 100,
      targetPrice: 10_000,
      days: 0.05,
      volatilityAtEntry: 0.2,
    });
    assert.equal(extreme.rawScore, YOLO_SCORE_CONFIG.maxPerBet);
    assert.equal(extreme.capped, true);
    assert.equal(extreme.scoreDelta, YOLO_SCORE_CONFIG.maxPerBet);
  });

  it("leaves an ordinary bet uncapped", () => {
    const ordinary = score({ entryPrice: 100, targetPrice: 120, days: 30 });
    assert.equal(ordinary.capped, false);
    assert.ok(ordinary.rawScore < YOLO_SCORE_CONFIG.maxPerBet);
  });
});

describe("the stored breakdown", () => {
  it("returns every component, not just the total", () => {
    // Stored so a score can be audited later and a future formula compared
    // against this one rather than replacing it silently.
    const result = score({});
    for (const key of ["targetMove", "expectedMove", "difficulty", "rawScore", "scoreDelta"]) {
      assert.ok(Number.isFinite((result as unknown as Record<string, number>)[key]), key);
    }
  });

  it("stamps the scoring version", () => {
    assert.equal(score({}).scoringVersion, YOLO_SCORING_VERSION);
    assert.equal(YOLO_SCORING_VERSION, "v1");
  });

  it("is internally consistent: difficulty is move over expected move", () => {
    const r = score({ entryPrice: 100, targetPrice: 140, days: 21, volatilityAtEntry: 0.55 });
    assert.ok(Math.abs(r.difficulty - r.targetMove / r.expectedMove) < 1e-4);
  });
});

describe("bad input", () => {
  it("refuses non-positive prices", () => {
    for (const [entry, target] of [
      [0, 100],
      [100, 0],
      [-10, 100],
      [Number.NaN, 100],
    ]) {
      const result = calculateYoloScore({
        entryPrice: entry!,
        targetPrice: target!,
        createdAt: CREATED,
        expiresAt: inDays(7),
        volatilityAtEntry: 0.4,
        outcome: "won",
      });
      assert.equal(result.scorable, false, `${entry} -> ${target}`);
    }
  });

  it("refuses a deadline that is not in the future", () => {
    const result = calculateYoloScore({
      entryPrice: 100,
      targetPrice: 150,
      createdAt: CREATED,
      expiresAt: CREATED,
      volatilityAtEntry: 0.4,
      outcome: "won",
    });
    assert.equal(result.scorable, false);
    assert.equal((result as { reason: string }).reason, "invalid_window");
  });

  it("refuses a target equal to entry", () => {
    const result = calculateYoloScore({
      entryPrice: 100,
      targetPrice: 100,
      createdAt: CREATED,
      expiresAt: inDays(7),
      volatilityAtEntry: 0.4,
      outcome: "won",
    });
    assert.equal(result.scorable, false);
    assert.equal((result as { reason: string }).reason, "no_move");
  });
});

describe("the triviality floor", () => {
  it("rejects a target that predicts noise", () => {
    assert.equal(meetsMinimumTargetMove(100, 100.01), false);
  });

  it("accepts a real move in either direction", () => {
    assert.equal(meetsMinimumTargetMove(100, 120), true);
    assert.equal(meetsMinimumTargetMove(100, 80), true);
  });
});

describe("direction", () => {
  it("is derived from the prices, never taken from the client", () => {
    assert.equal(directionFor(700, 850), "up");
    assert.equal(directionFor(700, 550), "down");
  });
});

/**
 * TOUCH, NOT CLOSE. A call that reaches the target intraday and settles below
 * it was still right about the thing it claimed.
 */
describe("target touch", () => {
  it("wins an UP bet on the high, even if the close is lower", () => {
    assert.equal(targetTouched("up", 120, { high: 120.01, low: 95 }), true);
    assert.equal(targetTouched("up", 120, { high: 119.99, low: 95 }), false);
  });

  it("wins a DOWN bet on the low", () => {
    assert.equal(targetTouched("down", 80, { high: 101, low: 79.5 }), true);
    assert.equal(targetTouched("down", 80, { high: 101, low: 80.5 }), false);
  });

  it("counts an exact touch as a touch", () => {
    assert.equal(targetTouched("up", 120, { high: 120, low: 100 }), true);
    assert.equal(targetTouched("down", 80, { high: 100, low: 80 }), true);
  });

  it("never wins on a bar with no data rather than guessing", () => {
    assert.equal(targetTouched("up", 120, { high: null, low: null }), false);
    assert.equal(targetTouched("down", 80, { high: null, low: null }), false);
  });
});
