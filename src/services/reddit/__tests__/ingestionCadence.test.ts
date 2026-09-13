import "../../../providers/reddit/__tests__/helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { env } from "../../../config/env.js";
import { getUsMarketSessionStatus } from "../../market/usMarketCalendar.js";
import { commentIntervalMs, postsIntervalMs } from "../redditSync.service.js";
import { ARCHIVE_PAGE_SIZE, boundsForArchive, boundsForPosts } from "../redditSyncPlan.js";

/**
 * HOW OFTEN EACH STREAM IS COLLECTED.
 *
 * Posts are a DISCOVERY stream — nobody is waiting for a thread to appear
 * within seconds, so ten minutes is ample. Comments are the live one, and they
 * follow the US regular session: a minute while the market is open, ten when it
 * is shut. The session itself comes from the market calendar, which is
 * holiday-, early-close- and DST-aware, and is in America/New_York regardless
 * of where the worker runs.
 */

const MINUTE = 60_000;

describe("posts cadence", () => {
  it("polls every ten minutes, market state irrelevant", () => {
    assert.equal(postsIntervalMs(), env.REDDIT_POSTS_INTERVAL_MINUTES * MINUTE);
    assert.equal(env.REDDIT_POSTS_INTERVAL_MINUTES, 10);
  });

  it("is one sync per ten minutes — six an hour, not sixty", () => {
    const perHour = 3_600_000 / postsIntervalMs();
    assert.equal(perHour, 6);
  });
});

describe("comments cadence follows the market", () => {
  it("runs every minute while the regular session is open", () => {
    assert.equal(commentIntervalMs(true), env.REDDIT_COMMENTS_MARKET_OPEN_INTERVAL_MINUTES * MINUTE);
    assert.equal(commentIntervalMs(true), 1 * MINUTE);
  });

  it("backs off to ten minutes when the market is shut", () => {
    assert.equal(commentIntervalMs(false), 10 * MINUTE);
  });

  it("is exactly ten times slower when closed — the whole point of the split", () => {
    assert.equal(commentIntervalMs(false) / commentIntervalMs(true), 10);
  });
});

describe("the market calendar decides, in New York time", () => {
  // A Wednesday in the middle of the session. 14:30Z is 10:30 ET in daylight
  // time — deliberately a UTC hour that is NOT inside 09:30-16:00, so a
  // timezone-blind implementation cannot pass this by accident.
  it("is open mid-session on an ordinary weekday", () => {
    const status = getUsMarketSessionStatus(new Date("2026-09-09T14:30:00Z"));
    assert.equal(status.isMarketDay, true);
    assert.equal(status.isRegularSessionOpen, true);
    assert.equal(status.timezone, "America/New_York");
    assert.equal(commentIntervalMs(status.isRegularSessionOpen), 1 * MINUTE);
  });

  it("is shut before the opening bell", () => {
    // 13:00Z = 09:00 ET, half an hour early.
    const status = getUsMarketSessionStatus(new Date("2026-09-09T13:00:00Z"));
    assert.equal(status.isRegularSessionOpen, false);
    assert.equal(commentIntervalMs(status.isRegularSessionOpen), 10 * MINUTE);
  });

  it("is shut at the weekend", () => {
    const status = getUsMarketSessionStatus(new Date("2026-09-12T15:00:00Z"));
    assert.equal(status.isMarketDay, false);
    assert.equal(commentIntervalMs(status.isRegularSessionOpen), 10 * MINUTE);
  });

  it("is shut on a market holiday, not merely on weekends", () => {
    // Christmas Day 2026 falls on a Friday — a weekday the exchange is closed.
    // A weekday-only check would run the expensive cadence straight through it.
    const status = getUsMarketSessionStatus(new Date("2026-12-25T15:00:00Z"));
    assert.equal(status.isMarketDay, false);
    assert.ok(status.holiday, "the holiday must be named so a log can explain itself");
    assert.equal(commentIntervalMs(status.isRegularSessionOpen), 10 * MINUTE);
  });

  it("respects an early close", () => {
    // The day after Thanksgiving 2026 closes at 13:00 ET. At 14:00 ET the
    // market is shut even though a 16:00 rule would say otherwise.
    const status = getUsMarketSessionStatus(new Date("2026-11-27T19:00:00Z"));
    assert.equal(status.isEarlyClose, true);
    assert.equal(status.isRegularSessionOpen, false);
    assert.equal(commentIntervalMs(status.isRegularSessionOpen), 10 * MINUTE);
  });

  it("tracks DST rather than a fixed UTC offset", () => {
    // 14:30Z is 10:30 ET in summer (open) but 09:30 ET in winter — the exact
    // minute of the opening bell. A hardcoded -4 or -5 gets one of these wrong.
    const summer = getUsMarketSessionStatus(new Date("2026-07-15T14:30:00Z"));
    const winter = getUsMarketSessionStatus(new Date("2026-01-14T14:00:00Z"));
    assert.equal(summer.isRegularSessionOpen, true, "10:30 ET in July is open");
    assert.equal(winter.isRegularSessionOpen, false, "09:00 ET in January is not yet open");
  });
});

describe("relative cadence over a ten-minute window", () => {
  it("attempts comments ten times and posts once while the market is open", () => {
    // The shape the cost model assumes, stated as arithmetic so a change to
    // either interval has to come past this test.
    const window = 10 * MINUTE;
    assert.equal(window / commentIntervalMs(true), 10);
    assert.equal(window / postsIntervalMs(), 1);
  });

  it("levels both streams to one attempt each when the market is shut", () => {
    const window = 10 * MINUTE;
    assert.equal(window / commentIntervalMs(false), 1);
    assert.equal(window / postsIntervalMs(), 1);
  });
});

describe("request sizing differs by who is paying", () => {
  it("asks the free archive for a full page every time", () => {
    // The adaptive sizer is a COST control: it shrinks requests because every
    // returned row is billed. On a free source shrinking buys nothing and costs
    // something real — a smaller page means more round trips to clear the same
    // backlog, so the stream stays behind for longer.
    const bounds = boundsForArchive();
    assert.equal(bounds.min, ARCHIVE_PAGE_SIZE);
    assert.equal(bounds.max, ARCHIVE_PAGE_SIZE);
    assert.equal(ARCHIVE_PAGE_SIZE, 100, "the archive refuses anything larger");
  });

  it("keeps the metered stream on the small adaptive bounds", () => {
    const bounds = boundsForPosts();
    assert.ok(bounds.max <= 100);
    assert.ok(bounds.min < bounds.max, "the metered path must still be able to shrink");
  });
});

describe("the incremental window", () => {
  it("re-requests a small overlap, because `after` is exclusive upstream", () => {
    // VERIFIED AGAINST THE LIVE ARCHIVE: querying `after=T` omits the item whose
    // timestamp is exactly T. Several items routinely share one second, so a
    // strict boundary at the checkpoint drops that item's siblings permanently.
    // The overlap re-requests them and de-duplication by id removes the repeats.
    assert.equal(env.ARCTIC_SHIFT_OVERLAP_SECONDS, 30);

    const checkpoint = new Date("2026-09-12T15:31:45Z");
    const after = new Date(checkpoint.getTime() - env.ARCTIC_SHIFT_OVERLAP_SECONDS * 1000);
    assert.equal(after.toISOString(), "2026-09-12T15:31:15.000Z");
  });

  it("bounds catch-up so a long outage cannot become an unbounded loop", () => {
    assert.equal(env.ARCTIC_SHIFT_MAX_PAGES_PER_SYNC, 5);
    // Five full pages is the most one tick may walk. Enough to clear a burst,
    // small enough that the tick always ends and the next one gets a turn.
    assert.equal(env.ARCTIC_SHIFT_MAX_PAGES_PER_SYNC * ARCHIVE_PAGE_SIZE, 500);
  });

  it("holds the fallback policy at the documented thresholds", () => {
    assert.equal(env.ARCTIC_SHIFT_FAILURE_THRESHOLD, 3);
    assert.equal(env.ARCTIC_SHIFT_MAX_LAG_MINUTES, 10);
    assert.equal(env.ARCTIC_SHIFT_RECOVERY_PROBE_MINUTES, 5);
  });
});
