import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isWithinPeriod,
  isYoloPeriod,
  wallClockInZone,
  YOLO_PERIODS,
  yoloPeriodBounds,
  zonedTimeToUtc,
} from "../yoloPeriods.js";

/**
 * Period windows decide which month a score lands in. Getting them wrong does
 * not throw — it quietly files results under the wrong heading, which is the
 * kind of bug a leaderboard hides for a month and then loses trust over.
 */

describe("the zone", () => {
  it("uses New York, not UTC", () => {
    // 01:30 UTC on 2 September is still 21:30 on 1 September in New York. A
    // UTC-keyed day would close the board mid-evening and split one session
    // across two "days".
    const w = wallClockInZone(new Date("2026-09-02T01:30:00.000Z"));
    assert.equal(w.day, 1);
    assert.equal(w.hour, 21);
  });

  it("converts local midnight to the right instant in summer and winter", () => {
    // EDT: UTC-4.
    assert.equal(zonedTimeToUtc(2026, 7, 15).toISOString(), "2026-07-15T04:00:00.000Z");
    // EST: UTC-5.
    assert.equal(zonedTimeToUtc(2026, 1, 15).toISOString(), "2026-01-15T05:00:00.000Z");
  });

  it("survives the spring-forward day", () => {
    // 8 March 2026 is a DST start in the US. Midnight is still EST that night.
    assert.equal(zonedTimeToUtc(2026, 3, 8).toISOString(), "2026-03-08T05:00:00.000Z");
    // And the following midnight is EDT — a 23-hour day.
    assert.equal(zonedTimeToUtc(2026, 3, 9).toISOString(), "2026-03-09T04:00:00.000Z");
  });

  it("survives the fall-back day", () => {
    assert.equal(zonedTimeToUtc(2026, 11, 1).toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(zonedTimeToUtc(2026, 11, 2).toISOString(), "2026-11-02T05:00:00.000Z");
  });
});

describe("daily", () => {
  it("runs local midnight to local midnight", () => {
    const { start, end } = yoloPeriodBounds("daily", new Date("2026-09-28T18:00:00.000Z"));
    assert.equal(start!.toISOString(), "2026-09-28T04:00:00.000Z");
    assert.equal(end.toISOString(), "2026-09-29T04:00:00.000Z");
  });

  it("keeps a late-evening result in the day the trader was trading", () => {
    // 23:00 in New York on the 28th is 03:00 UTC on the 29th.
    const now = new Date("2026-09-29T03:00:00.000Z");
    const { start, end, label } = yoloPeriodBounds("daily", now);
    assert.ok(isWithinPeriod(now, { start, end, label }));
    assert.equal(label, "Sep 28, 2026");
  });

  it("is 23 hours long on the spring-forward day", () => {
    const { start, end } = yoloPeriodBounds("daily", new Date("2026-03-08T18:00:00.000Z"));
    assert.equal((end.getTime() - start!.getTime()) / 3_600_000, 23);
  });

  it("is 25 hours long on the fall-back day", () => {
    const { start, end } = yoloPeriodBounds("daily", new Date("2026-11-01T18:00:00.000Z"));
    assert.equal((end.getTime() - start!.getTime()) / 3_600_000, 25);
  });
});

describe("weekly", () => {
  it("runs Monday to Monday", () => {
    // 2026-09-28 is a Monday.
    const { start, end } = yoloPeriodBounds("weekly", new Date("2026-09-30T18:00:00.000Z"));
    assert.equal(start!.toISOString(), "2026-09-28T04:00:00.000Z");
    assert.equal(end.toISOString(), "2026-10-05T04:00:00.000Z");
  });

  it("puts Sunday at the END of its week, not the start", () => {
    // 2026-10-04 is a Sunday: it belongs to the week beginning 28 September.
    const { start } = yoloPeriodBounds("weekly", new Date("2026-10-04T18:00:00.000Z"));
    assert.equal(start!.toISOString(), "2026-09-28T04:00:00.000Z");
  });

  it("spans exactly seven local days across a DST change", () => {
    // The week containing 1 November 2026 gains an hour; it is still 7 days.
    const { start, end } = yoloPeriodBounds("weekly", new Date("2026-10-28T18:00:00.000Z"));
    const hours = (end.getTime() - start!.getTime()) / 3_600_000;
    assert.equal(hours, 7 * 24 + 1, `${hours}`);
  });
});

describe("monthly", () => {
  it("runs the calendar month in local time", () => {
    const { start, end, label } = yoloPeriodBounds("monthly", new Date("2026-09-15T18:00:00.000Z"));
    assert.equal(start!.toISOString(), "2026-09-01T04:00:00.000Z");
    assert.equal(end.toISOString(), "2026-10-01T04:00:00.000Z");
    assert.equal(label, "September 2026");
  });

  it("rolls the year over in December", () => {
    const { start, end } = yoloPeriodBounds("monthly", new Date("2026-12-20T18:00:00.000Z"));
    assert.equal(start!.toISOString(), "2026-12-01T05:00:00.000Z");
    assert.equal(end.toISOString(), "2027-01-01T05:00:00.000Z");
  });

  /**
   * THE RULE THAT MAKES RANKINGS UNAMBIGUOUS: a period is keyed on when a bet
   * RESOLVED, not when it was placed. This is the spec's worked example.
   */
  it("files an August bet resolved in September under September", () => {
    const createdAt = new Date("2026-08-30T14:00:00.000Z");
    const resolvedAt = new Date("2026-09-02T14:00:00.000Z");

    const august = yoloPeriodBounds("monthly", new Date("2026-08-15T18:00:00.000Z"));
    const september = yoloPeriodBounds("monthly", new Date("2026-09-15T18:00:00.000Z"));

    assert.equal(isWithinPeriod(resolvedAt, august), false, "August must not claim it");
    assert.equal(isWithinPeriod(resolvedAt, september), true, "September must");
    // And the creation date is irrelevant to the filing.
    assert.equal(isWithinPeriod(createdAt, august), true);
    assert.equal(isWithinPeriod(createdAt, september), false);
  });
});

describe("all time", () => {
  /**
   * The bound is BOUND AS A SQL PARAMETER. JavaScript's maximum date (year
   * 275760) is a legal Date and an illegal timestamp to the Postgres driver,
   * which turned every All Time board into a 500 while these unit tests stayed
   * green. The window must stay inside a range the whole stack accepts.
   */
  it("uses an end date the database can actually accept", () => {
    const { end } = yoloPeriodBounds("alltime");
    assert.ok(end.getUTCFullYear() <= 9999, `year ${end.getUTCFullYear()} is out of range`);
    assert.ok(end.getUTCFullYear() >= 9000, "and still far enough out to include everything");
    assert.equal(Number.isNaN(end.getTime()), false);
    // Serializable: the failure mode was in converting it for the wire.
    assert.equal(typeof end.toISOString(), "string");
  });

  it("has no lower bound and admits everything", () => {
    const window = yoloPeriodBounds("alltime");
    assert.equal(window.start, null);
    assert.equal(isWithinPeriod(new Date("2001-01-01T00:00:00.000Z"), window), true);
    assert.equal(isWithinPeriod(new Date(), window), true);
  });
});

describe("the vocabulary", () => {
  it("is exactly the four the UI offers", () => {
    assert.deepEqual([...YOLO_PERIODS], ["daily", "weekly", "monthly", "alltime"]);
    for (const p of YOLO_PERIODS) assert.equal(isYoloPeriod(p), true);
    assert.equal(isYoloPeriod("yearly"), false);
    assert.equal(isYoloPeriod(undefined), false);
  });
});
