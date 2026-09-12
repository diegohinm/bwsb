import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getUsMarketSessionStatus, isUsMarketOpen } from "../usMarketCalendar.js";

/**
 * The calendar that decides how often Mindcase gets paid.
 *
 * Every case here is a day on which the previous weekday-only implementation
 * would have run the one-minute comment cadence against a closed market. They
 * are pinned as real dates rather than synthetic ones because the rules are
 * only correct if they reproduce the actual NYSE schedule.
 */

const at = (iso: string) => new Date(iso);

/** 14:00 ET expressed in UTC — inside the session on any normal trading day. */
const middayEt = (date: string, offset = "-04:00") => at(`${date}T14:00:00${offset}`);

describe("ordinary trading days", () => {
  it("is open at midday on a summer weekday", () => {
    assert.equal(isUsMarketOpen(middayEt("2026-09-11")), true);
  });

  it("is open at midday on a winter weekday, when the offset is -05:00", () => {
    assert.equal(isUsMarketOpen(middayEt("2026-01-14", "-05:00")), true);
  });

  it("is closed one minute before the opening bell", () => {
    assert.equal(isUsMarketOpen(at("2026-09-11T09:29:00-04:00")), false);
  });

  it("is open exactly at the opening bell", () => {
    assert.equal(isUsMarketOpen(at("2026-09-11T09:30:00-04:00")), true);
  });

  it("is closed exactly at the closing bell", () => {
    // Half-open: 16:00 belongs to the closed state, not the open one.
    assert.equal(isUsMarketOpen(at("2026-09-11T16:00:00-04:00")), false);
  });

  it("reports the session boundaries as real instants", () => {
    const status = getUsMarketSessionStatus(middayEt("2026-09-11"));
    assert.equal(status.sessionOpen, "2026-09-11T13:30:00.000Z");
    assert.equal(status.sessionClose, "2026-09-11T20:00:00.000Z");
  });
});

describe("weekends", () => {
  it("is closed on Saturday", () => {
    const status = getUsMarketSessionStatus(middayEt("2026-09-12"));
    assert.equal(status.isMarketDay, false);
    assert.equal(status.isRegularSessionOpen, false);
  });

  it("is closed on Sunday", () => {
    assert.equal(getUsMarketSessionStatus(middayEt("2026-09-13")).isMarketDay, false);
  });
});

describe("NYSE holidays", () => {
  // Each of these is a weekday. The weekday-only check called every one open.
  const cases: [string, string, string][] = [
    ["2026-01-01", "New Year's Day", "-05:00"],
    ["2026-01-19", "Martin Luther King Jr. Day", "-05:00"],
    ["2026-02-16", "Washington's Birthday", "-05:00"],
    ["2026-04-03", "Good Friday", "-04:00"],
    ["2026-05-25", "Memorial Day", "-04:00"],
    ["2026-06-19", "Juneteenth", "-04:00"],
    ["2026-07-03", "Independence Day", "-04:00"],
    ["2026-09-07", "Labor Day", "-04:00"],
    ["2026-11-26", "Thanksgiving Day", "-05:00"],
    ["2026-12-25", "Christmas Day", "-05:00"],
  ];

  for (const [date, name, offset] of cases) {
    it(`is closed on ${name} (${date})`, () => {
      const status = getUsMarketSessionStatus(middayEt(date, offset));
      assert.equal(status.isMarketDay, false, `${name} was treated as a trading day`);
      assert.equal(status.isRegularSessionOpen, false);
      assert.ok(status.holiday, `${name} should be named in the status`);
    });
  }

  it("moves a Saturday holiday to the Friday before", () => {
    // July 4 2026 is a Saturday, so the exchange closes Friday July 3.
    assert.equal(getUsMarketSessionStatus(middayEt("2026-07-03")).holiday, "Independence Day");
  });

  it("moves a Sunday holiday to the Monday after", () => {
    // July 4 2027 is a Sunday → observed Monday July 5.
    assert.equal(getUsMarketSessionStatus(middayEt("2027-07-05")).holiday, "Independence Day");
    assert.equal(getUsMarketSessionStatus(middayEt("2027-07-02")).isMarketDay, true);
  });

  it("does NOT close the Friday before a Saturday New Year's Day", () => {
    // Jan 1 2028 is a Saturday. The NYSE trades Friday Dec 31 2027 as normal —
    // the general Saturday rule must not be applied here.
    const dec31 = getUsMarketSessionStatus(middayEt("2027-12-31", "-05:00"));
    assert.equal(dec31.isMarketDay, true);
    assert.equal(dec31.holiday, null);
  });

  it("tracks Good Friday as Easter moves", () => {
    // Easter 2027 is March 28, so Good Friday is March 26 — a week earlier than
    // 2026's April 3. A hardcoded date list gets exactly this wrong.
    assert.equal(getUsMarketSessionStatus(middayEt("2027-03-26", "-04:00")).holiday, "Good Friday");
    assert.equal(getUsMarketSessionStatus(middayEt("2026-04-03", "-04:00")).holiday, "Good Friday");

    // April 2 2027 is an ordinary Friday — the slot Good Friday occupies in
    // other years, which is the case a fixed rule would wrongly close.
    assert.equal(getUsMarketSessionStatus(middayEt("2027-04-02", "-04:00")).isMarketDay, true);
  });

  it("does not treat Juneteenth as a holiday before it became one", () => {
    assert.equal(getUsMarketSessionStatus(middayEt("2021-06-18")).isMarketDay, true);
  });
});

describe("early closes", () => {
  it("closes at 13:00 the day after Thanksgiving", () => {
    const status = getUsMarketSessionStatus(middayEt("2026-11-27", "-05:00"));
    assert.equal(status.isEarlyClose, true);
    assert.equal(status.sessionClose, "2026-11-27T18:00:00.000Z");
  });

  it("is CLOSED at 14:00 on an early-close day", () => {
    // The whole point: 14:00 is inside the normal session and outside this one.
    assert.equal(isUsMarketOpen(middayEt("2026-11-27", "-05:00")), false);
  });

  it("is still open at 12:00 on an early-close day", () => {
    assert.equal(isUsMarketOpen(at("2026-11-27T12:00:00-05:00")), true);
  });

  it("closes early on Christmas Eve when it is a weekday", () => {
    assert.equal(getUsMarketSessionStatus(at("2026-12-24T12:00:00-05:00")).isEarlyClose, true);
  });

  it("does not invent an early close when Christmas Eve is a weekend", () => {
    // Dec 24 2027 is a Friday; Dec 24 2028 is a Sunday.
    assert.equal(getUsMarketSessionStatus(at("2028-12-24T12:00:00-05:00")).isEarlyClose, false);
  });
});

describe("daylight saving transitions", () => {
  it("keeps 09:30 ET the boundary on the spring-forward day", () => {
    // 2026-03-08: clocks jump 02:00 → 03:00 EST→EDT.
    assert.equal(isUsMarketOpen(at("2026-03-09T09:29:00-04:00")), false);
    assert.equal(isUsMarketOpen(at("2026-03-09T09:30:00-04:00")), true);
  });

  it("keeps 09:30 ET the boundary on the fall-back day", () => {
    // 2026-11-01: clocks fall back. The Monday after is plain EST.
    assert.equal(isUsMarketOpen(at("2026-11-02T09:29:00-05:00")), false);
    assert.equal(isUsMarketOpen(at("2026-11-02T09:30:00-05:00")), true);
  });

  it("does not shift the session by an hour across the transition", () => {
    const before = getUsMarketSessionStatus(middayEt("2026-10-30"));
    const after = getUsMarketSessionStatus(middayEt("2026-11-03", "-05:00"));
    // Both are 09:30 local; the UTC instants differ by exactly the DST hour.
    assert.equal(before.sessionOpen, "2026-10-30T13:30:00.000Z");
    assert.equal(after.sessionOpen, "2026-11-03T14:30:00.000Z");
  });
});
