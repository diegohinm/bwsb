import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultRange,
  isCalendarView,
  isSocialTimeframe,
  normalizeStatus,
  normalizeTiming,
  parseDateKey,
  publicPriceCutoff,
  toDateKey,
  PUBLIC_DELAY_MINUTES,
} from "../calendarVocabulary.js";
import { mockEarningsProvider } from "../providers/mockEarnings.provider.js";
import { noneEarningsProvider } from "../providers/noneEarnings.provider.js";

/**
 * The calendar's honesty lives in two coercions and one date parser.
 *
 * A provider that omits a confirmation flag must not produce a confirmed date,
 * a provider that writes "TBD" for timing must not produce "before market", and
 * a hand-edited `?date=` must not become a real-looking day. These tests pin
 * all three, because each failure would be invisible in the UI — the calendar
 * would simply look more certain than it is.
 */

describe("timing normalization", () => {
  it("maps the common provider spellings", () => {
    assert.equal(normalizeTiming("BMO"), "before_market");
    assert.equal(normalizeTiming("bmo"), "before_market");
    assert.equal(normalizeTiming("Before Market Open"), "before_market");
    assert.equal(normalizeTiming("AMC"), "after_market");
    assert.equal(normalizeTiming("post-market"), "after_market");
    assert.equal(normalizeTiming("during"), "during_market");
  });

  it("passes vocabulary values through untouched", () => {
    assert.equal(normalizeTiming("after_market"), "after_market");
    assert.equal(normalizeTiming("unknown"), "unknown");
  });

  it("refuses to guess: anything unrecognized is unknown", () => {
    for (const raw of ["TAS", "--", "", "  ", 7, null, undefined, {}, "morning-ish"]) {
      assert.equal(normalizeTiming(raw), "unknown", `${String(raw)} should be unknown`);
    }
  });
});

describe("status normalization", () => {
  it("recognizes the confirmed spellings", () => {
    assert.equal(normalizeStatus("confirmed"), "confirmed");
    assert.equal(normalizeStatus("Verified"), "confirmed");
    assert.equal(normalizeStatus("SCHEDULED"), "confirmed");
    assert.equal(normalizeStatus("official"), "confirmed");
  });

  it("defaults to estimated — an unlabelled date is an unconfirmed date", () => {
    for (const raw of [undefined, null, "", "probably", "tentative", 1, {}]) {
      assert.equal(normalizeStatus(raw), "estimated", `${String(raw)} should be estimated`);
    }
  });
});

describe("date keys", () => {
  it("round-trips a valid key", () => {
    const date = parseDateKey("2026-08-19");
    assert.ok(date);
    assert.equal(toDateKey(date), "2026-08-19");
    // Parsed at UTC midnight, so the day never shifts by timezone.
    assert.equal(date.getUTCHours(), 0);
  });

  it("rejects impossible and malformed dates instead of rolling them forward", () => {
    // Date would silently turn 2026-02-31 into March 3rd.
    assert.equal(parseDateKey("2026-02-31"), null);
    assert.equal(parseDateKey("2026-13-01"), null);
    assert.equal(parseDateKey("nonsense"), null);
    assert.equal(parseDateKey("2026-8-1"), null);
    assert.equal(parseDateKey(""), null);
    assert.equal(parseDateKey(undefined), null);
    assert.equal(parseDateKey(12345), null);
  });
});

describe("views and timeframes", () => {
  it("accepts only the three views", () => {
    assert.ok(isCalendarView("month"));
    assert.ok(isCalendarView("week"));
    assert.ok(isCalendarView("list"));
    assert.equal(isCalendarView("agenda"), false);
    assert.equal(isCalendarView(null), false);
  });

  it("accepts only the three social windows", () => {
    assert.ok(isSocialTimeframe("24h"));
    assert.ok(isSocialTimeframe("7d"));
    assert.ok(isSocialTimeframe("30d"));
    assert.equal(isSocialTimeframe("1y"), false);
  });
});

describe("public delay", () => {
  it("quotes nothing newer than the delay", () => {
    const now = new Date("2026-08-19T15:00:00.000Z");
    const cutoff = publicPriceCutoff(now);
    assert.equal(now.getTime() - cutoff.getTime(), PUBLIC_DELAY_MINUTES * 60 * 1000);
  });
});

describe("default range", () => {
  it("pads the month so a grid's leading and trailing days are populated", () => {
    const { start, end } = defaultRange(new Date("2026-08-19T00:00:00.000Z"));
    assert.equal(toDateKey(start), "2026-07-25");
    assert.equal(toDateKey(end), "2026-09-07");
  });
});

describe("the none provider", () => {
  it("reports itself unconfigured and returns nothing", async () => {
    const status = await noneEarningsProvider.getStatus();
    assert.equal(status.configured, false);
    assert.equal(status.isMock, false);
    assert.deepEqual(await noneEarningsProvider.getEarningsEvents(), []);
    assert.deepEqual(await noneEarningsProvider.getTickerEarnings(), []);
  });
});

describe("the mock provider", () => {
  it("marks itself as mock", async () => {
    const status = await mockEarningsProvider.getStatus();
    assert.equal(status.isMock, true);
    assert.equal(mockEarningsProvider.isMock, true);
  });

  it("is deterministic, so a re-run updates rather than duplicates", async () => {
    const a = await mockEarningsProvider.getEarningsEvents("2026-08-01", "2026-12-31", ["RDDT"]);
    const b = await mockEarningsProvider.getEarningsEvents("2026-08-01", "2026-12-31", ["RDDT"]);
    assert.deepEqual(
      a.map((e) => [e.externalId, e.reportDate]),
      b.map((e) => [e.externalId, e.reportDate]),
    );
    assert.ok(a.length > 0);
  });

  it("never fabricates a clock time or a company name", async () => {
    const events = await mockEarningsProvider.getEarningsEvents(
      "2026-08-01",
      "2027-06-30",
      ["RDDT", "NVDA"],
    );
    for (const event of events) {
      assert.equal(event.reportTime, null, "a demo provider must not invent a report time");
      assert.equal(event.companyName, null, "a demo provider must not invent a legal name");
      assert.ok(parseDateKey(event.reportDate), "every date must be a real calendar date");
    }
  });

  it("keeps every event inside the requested window", async () => {
    const events = await mockEarningsProvider.getEarningsEvents(
      "2026-09-01",
      "2026-09-30",
      ["AAPL", "MSFT", "NVDA"],
    );
    for (const event of events) {
      assert.ok(event.reportDate >= "2026-09-01");
      assert.ok(event.reportDate <= "2026-09-30");
    }
  });

  it("returns nothing for an unparseable window rather than guessing one", async () => {
    assert.deepEqual(
      await mockEarningsProvider.getEarningsEvents("nope", "2026-09-30", ["AAPL"]),
      [],
    );
  });
});
