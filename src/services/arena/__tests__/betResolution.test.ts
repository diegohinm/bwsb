import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAgainstBars, type ResolutionBar } from "../betResolution.service.js";

/**
 * Resolution decides whether a call was right. Two ways to get it wrong that
 * both look reasonable in code: judging on the close (marks a correct intraday
 * call wrong), and treating missing bars as "never touched" (marks an unknown
 * outcome as a loss). Both are tested here.
 */

const HOUR = 3_600_000;
const START = new Date("2026-09-01T13:30:00.000Z");
const bar = (hoursIn: number, high: number, low: number, close: number): ResolutionBar => ({
  timestamp: new Date(START.getTime() + hoursIn * HOUR),
  high,
  low,
  close,
});

const EXPIRES = new Date(START.getTime() + 6 * HOUR);
const AFTER = new Date(START.getTime() + 8 * HOUR);

describe("UP bets", () => {
  it("wins when the high touches the target", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [
      bar(0, 105, 99, 103),
      bar(1, 121, 110, 118),
    ], "1h");
    assert.equal(outcome.status, "won");
    assert.equal((outcome as { resultPrice: number }).resultPrice, 121);
  });

  /** The spec's example: $850.01 intraday, closes at $840. Still a win. */
  it("wins on an intraday touch the close gave back", () => {
    const outcome = resolveAgainstBars("up", 850, EXPIRES, AFTER, [
      bar(0, 845, 830, 842),
      bar(1, 850.01, 838, 840),
      bar(2, 843, 835, 840),
    ], "1m");
    assert.equal(outcome.status, "won");
  });

  it("loses when the high never reaches the target", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [
      bar(0, 105, 99, 103),
      bar(1, 119.99, 110, 118),
    ], "1h");
    assert.equal(outcome.status, "lost");
    // The last close is reported for context — it did not decide anything.
    assert.equal((outcome as { resultPrice: number | null }).resultPrice, 118);
  });

  it("counts an exact touch", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [bar(1, 120, 110, 115)], "1h");
    assert.equal(outcome.status, "won");
  });
});

describe("DOWN bets", () => {
  it("wins when the low touches the target", () => {
    const outcome = resolveAgainstBars("down", 80, EXPIRES, AFTER, [
      bar(0, 101, 95, 97),
      bar(1, 96, 79.5, 85),
    ], "1h");
    assert.equal(outcome.status, "won");
    assert.equal((outcome as { resultPrice: number }).resultPrice, 79.5);
  });

  it("loses when the low never reaches the target", () => {
    const outcome = resolveAgainstBars("down", 80, EXPIRES, AFTER, [
      bar(0, 101, 95, 97),
      bar(1, 96, 80.5, 85),
    ], "1h");
    assert.equal(outcome.status, "lost");
  });
});

describe("the deadline", () => {
  it("stays active while the window is open and untouched", () => {
    const duringWindow = new Date(START.getTime() + 2 * HOUR);
    const outcome = resolveAgainstBars("up", 120, EXPIRES, duringWindow, [
      bar(0, 105, 99, 103),
    ], "1h");
    assert.equal(outcome.status, "active");
  });

  /** A touch one bar after expiry is a day late, not a win. */
  it("ignores a touch that happened after the deadline", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [
      bar(1, 110, 100, 105),
      bar(7, 130, 120, 128),
    ], "1h");
    assert.equal(outcome.status, "lost");
  });

  it("resolves at the deadline, not at the last bar", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [bar(1, 110, 100, 105)], "1h");
    assert.equal((outcome as { resolvedAt: Date }).resolvedAt.getTime(), EXPIRES.getTime());
  });
});

/**
 * MISSING DATA IS NOT A LOSS. If no bars cover the window we do not know what
 * happened, and recording a loss would blame the bettor for our gap.
 */
describe("missing bars", () => {
  it("reports unresolvable rather than lost when no bars cover the window", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [], "1d");
    assert.equal(outcome.status, "unresolvable");
    assert.equal((outcome as { reason: string }).reason, "no_bars");
  });

  it("reports unresolvable when every bar sits outside the window", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [bar(7, 130, 120, 128)], "1h");
    assert.equal(outcome.status, "unresolvable");
  });

  it("does not win on a bar with null high or low", () => {
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [
      { timestamp: new Date(START.getTime() + HOUR), high: null, low: null, close: 118 },
    ], "1h");
    assert.equal(outcome.status, "lost");
  });
});

describe("bar ordering", () => {
  it("finds the FIRST touch even when bars arrive out of order", () => {
    // The resolution timestamp is when the call came good, so a later touch
    // must not be the one reported.
    const outcome = resolveAgainstBars("up", 120, EXPIRES, AFTER, [
      bar(3, 125, 115, 122),
      bar(1, 121, 110, 118),
    ], "1h");
    assert.equal(outcome.status, "won");
    assert.equal(
      (outcome as { resolvedAt: Date }).resolvedAt.getTime(),
      START.getTime() + HOUR,
    );
  });

  it("is idempotent — the same bars always give the same answer", () => {
    const bars = [bar(0, 105, 99, 103), bar(1, 121, 110, 118)];
    const a = resolveAgainstBars("up", 120, EXPIRES, AFTER, bars, "1h");
    const b = resolveAgainstBars("up", 120, EXPIRES, AFTER, bars, "1h");
    assert.deepEqual(a, b);
  });
});
