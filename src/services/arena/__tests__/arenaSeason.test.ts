import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { Prisma } from "@prisma/client";
import express from "express";

import { prisma } from "../../../lib/prisma.js";
import { errorHandler } from "../../../middleware/errorHandler.js";
import { yoloArenaRouter } from "../../../routes/yoloArena.routes.js";
import {
  ARENA_SEASON_PERIOD,
  assembleArenaSeason,
  describeSeason,
  readArenaSeason,
  toActivity,
  type ActivityCountsRow,
} from "../arenaSeason.service.js";
import { yoloPeriodBounds } from "../yoloPeriods.js";

/**
 * The Arena season contract behind the Dashboard's Yolo Arena promo.
 *
 * The promo used to print "SEASON 04" and "The trading arena is open." from a
 * fixture. Each case pins one way the season could be invented again: a number
 * nobody defined, an "open" arena whose window has passed, a countdown to a date
 * the boards do not use, or a zero-bet season standing in for a failed count.
 */

// Tue 2026-11-10 11:00 New York (EST, UTC-5).
const NOW = new Date("2026-11-10T16:00:00.000Z");

function counts(overrides: Partial<Record<keyof ActivityCountsRow, bigint>> = {}): ActivityCountsRow {
  return { placed: 0n, open: 0n, settled: 0n, competitors: 0n, ...overrides };
}

describe("the season is the Arena's monthly board", () => {
  it("is drawn from the same window the default leaderboard ranks", () => {
    assert.equal(ARENA_SEASON_PERIOD, "monthly");
    const board = yoloPeriodBounds("monthly", NOW);
    const season = describeSeason(board, NOW);
    assert.equal(season.startsAt, board.start!.toISOString());
    assert.equal(season.endsAt, board.end.toISOString());
    assert.equal(season.label, board.label);
    assert.equal(season.board, "monthly");
  });

  it("names the month in New York time — and carries no season number", () => {
    const season = describeSeason(yoloPeriodBounds("monthly", NOW), NOW);
    assert.equal(season.key, "2026-11");
    assert.equal(season.label, "November 2026");
    assert.equal(season.shortLabel, "NOV 2026");
    assert.equal(season.timeZone, "America/New_York");
    // Midnight EDT on the 1st, midnight EST on 1 December (DST ended in between).
    assert.equal(season.startsAt, "2026-11-01T04:00:00.000Z");
    assert.equal(season.endsAt, "2026-12-01T05:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(season), /season\s*0?\d/i);
  });

  it("rolls the year over in December", () => {
    const dec = new Date("2026-12-31T23:00:00.000Z"); // 18:00 New York, 31 Dec
    const season = describeSeason(yoloPeriodBounds("monthly", dec), dec);
    assert.equal(season.key, "2026-12");
    assert.equal(season.shortLabel, "DEC 2026");
    assert.equal(season.endsAt, "2027-01-01T05:00:00.000Z");
  });

  it("keeps the old month at 22:00 New York on its last day, though UTC has moved on", () => {
    const lateOct = new Date("2026-11-01T02:00:00.000Z"); // 22:00 EDT, 31 Oct
    const season = describeSeason(yoloPeriodBounds("monthly", lateOct), lateOct);
    assert.equal(season.key, "2026-10");
    assert.equal(season.shortLabel, "OCT 2026");
    assert.equal(season.status, "open");
  });

  it("refuses the all-time window: it has nothing to count down to", () => {
    assert.throws(() => describeSeason(yoloPeriodBounds("alltime", NOW), NOW), /bounded window/);
  });
});

describe("open, closed and progress are derived from the clock", () => {
  const window = yoloPeriodBounds("monthly", NOW);

  it("is open inside its window, with the elapsed share of the month", () => {
    const season = describeSeason(window, NOW);
    assert.equal(season.status, "open");
    // 9 days 12 hours (+1h DST) into a 30-day, 721-hour month.
    const expected = Math.round(((NOW.getTime() - window.start!.getTime()) / (window.end.getTime() - window.start!.getTime())) * 1000) / 10;
    assert.equal(season.elapsedPct, expected);
    assert.ok(season.elapsedPct > 30 && season.elapsedPct < 32);
  });

  it("is open at its first instant and closed at its exclusive end", () => {
    assert.equal(describeSeason(window, window.start!).status, "open");
    assert.equal(describeSeason(window, window.start!).elapsedPct, 0);
    const closed = describeSeason(window, window.end);
    assert.equal(closed.status, "closed");
    assert.equal(closed.elapsedPct, 100);
  });

  it("never reports a window that has not started yet as open", () => {
    const before = new Date(window.start!.getTime() - 1);
    const season = describeSeason(window, before);
    assert.equal(season.status, "closed");
    assert.equal(season.elapsedPct, 0);
  });
});

describe("activity is counted, never filled in", () => {
  it("converts Postgres bigints without changing them", () => {
    assert.deepEqual(toActivity(counts({ placed: 4n, open: 2n, settled: 7n, competitors: 3n })), {
      placed: 4,
      open: 2,
      settled: 7,
      competitors: 3,
    });
  });

  it("reports a quiet season as zeros — those zeros are counts", () => {
    assert.deepEqual(toActivity(counts()), { placed: 0, open: 0, settled: 0, competitors: 0 });
  });

  it("throws instead of inventing a zero-bet season when the count did not come back", () => {
    assert.throws(() => toActivity(undefined), /no row/);
  });

  it("keeps the two contests side by side and never sums them", () => {
    const view = assembleArenaSeason({
      now: NOW,
      window: yoloPeriodBounds("monthly", NOW),
      banbet: counts({ settled: 1n, competitors: 1n }),
      yolopulse: counts({ placed: 2n, open: 2n }),
    });
    assert.deepEqual(Object.keys(view.contests).sort(), ["banbet", "yolopulse"]);
    assert.equal(view.contests.banbet.settled, 1);
    assert.equal(view.contests.yolopulse.open, 2);
    assert.equal(view.meta.asOf, NOW.toISOString());
    assert.equal(view.meta.source, "database");
    assert.ok(!("total" in view.contests));
  });
});

/**
 * Prisma's client is a proxy that node:test's `mock.method` cannot wrap, but its
 * `$queryRaw` is an own property that plain assignment replaces. Restored after
 * every test, so nothing here can reach a real database.
 */
const realQueryRaw = prisma.$queryRaw;
function stubQueryRaw(fn: (query: Prisma.Sql) => Promise<unknown>) {
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = fn;
}
function restoreQueryRaw() {
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = realQueryRaw;
}

describe("readArenaSeason queries stored bets only", () => {
  it("counts confirmed, non-mock banbets and YOLOPulse bets inside the season window", async () => {
    const sql: string[] = [];
    const values: unknown[][] = [];
    const query = async (q: Prisma.Sql) => {
      sql.push(q.sql);
      values.push(q.values);
      return q.sql.includes("wsb_banbets")
        ? [counts({ settled: 1n, competitors: 1n })]
        : [counts({ placed: 3n, open: 1n, settled: 2n, competitors: 2n })];
    };

    const view = await readArenaSeason(NOW, query);

    assert.equal(sql.length, 2);
    const banbet = sql.find((s) => s.includes("wsb_banbets"))!;
    const yolo = sql.find((s) => s.includes("yolo_bets"))!;
    assert.match(banbet, /confirmation = 'confirmed'/);
    assert.match(banbet, /is_mock = false/);
    assert.match(yolo, /status IN \('won','lost'\)/);
    // Both windows are the season's own bounds.
    for (const v of values) {
      const dates = v.filter((x): x is Date => x instanceof Date).map((d) => d.toISOString());
      assert.ok(dates.includes("2026-11-01T04:00:00.000Z"));
      assert.ok(dates.includes("2026-12-01T05:00:00.000Z"));
    }

    assert.equal(view.season.shortLabel, "NOV 2026");
    assert.deepEqual(view.contests.banbet, { placed: 0, open: 0, settled: 1, competitors: 1 });
    assert.deepEqual(view.contests.yolopulse, { placed: 3, open: 1, settled: 2, competitors: 2 });
  });

  it("lets a database failure propagate", async () => {
    const query = async () => {
      throw new Error("connection refused");
    };
    await assert.rejects(readArenaSeason(NOW, query), /connection refused/);
  });
});

describe("GET /api/arena/season", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use("/api", yoloArenaRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(restoreQueryRaw);

  it("serves the season and both contests inside the { data } envelope, without a session", async () => {
    stubQueryRaw(async () => [counts({ open: 2n })]);
    const response = await fetch(`${baseUrl}/api/arena/season`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Record<string, any> };
    assert.equal(body.data.season.board, "monthly");
    assert.match(body.data.season.key, /^\d{4}-\d{2}$/);
    assert.equal(body.data.season.status, "open");
    assert.equal(body.data.contests.banbet.open, 2);
    assert.equal(body.data.contests.yolopulse.open, 2);
    assert.equal(typeof body.data.meta.asOf, "string");
  });

  it("answers 500 — not an open arena — when the bets cannot be counted", async () => {
    stubQueryRaw(async () => {
      throw new Error("db down");
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await fetch(`${baseUrl}/api/arena/season`);
      assert.equal(response.status, 500);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.data, undefined);
    } finally {
      console.error = originalError;
    }
  });
});
