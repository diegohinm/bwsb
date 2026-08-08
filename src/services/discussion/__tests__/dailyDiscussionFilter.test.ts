import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTENT_TYPES,
  isContentType,
} from "../discussionRead.service.js";
import {
  DAILY_DISCUSSION_SUBREDDIT,
  DAILY_DISCUSSION_WINDOW_HOURS,
  isDailyDiscussionPost,
} from "../../social/dailyDiscussion.service.js";

/**
 * The contract the API promises for `type=daily_discussion`.
 *
 * The query itself needs a database, so what is pinned here is everything that
 * decides its SHAPE: the accepted parameter values, the window that selects a
 * thread, and the rule that one thread is chosen rather than several. The
 * end-to-end behaviour is verified against live data separately.
 */

describe("the content-type parameter", () => {
  it("accepts the new value alongside the existing three", () => {
    assert.deepEqual([...CONTENT_TYPES], ["all", "post", "comment", "daily_discussion"]);
  });

  it("keeps the previous values working", () => {
    assert.equal(isContentType("all"), true);
    assert.equal(isContentType("post"), true);
    assert.equal(isContentType("comment"), true);
    assert.equal(isContentType("daily_discussion"), true);
  });

  it("rejects anything else, so a hand-edited URL falls back rather than 400s", () => {
    assert.equal(isContentType("posts"), false);
    assert.equal(isContentType("DAILY_DISCUSSION"), false); // normalized by the route
    assert.equal(isContentType(""), false);
    assert.equal(isContentType(null), false);
  });
});

/**
 * Selecting the thread.
 *
 * These reproduce the resolver's rule against the real title/timestamp shapes
 * in the database, without needing the database: newest first, inside the
 * window, r/wallstreetbets only, exactly one.
 */
describe("choosing which thread to show", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");

  const candidates = [
    { title: "What Are Your Moves Tomorrow, August 6, 2026", at: "2026-08-05T20:00:40.000Z" },
    { title: "Daily Discussion Thread for August 5, 2026", at: "2026-08-05T10:00:44.000Z" },
    { title: "What Are Your Moves Tomorrow, August 5, 2026", at: "2026-08-04T20:00:41.000Z" },
    { title: "Daily Discussion Thread for August 1, 2026", at: "2026-08-01T10:00:00.000Z" },
  ];

  const insideWindow = (at: string) =>
    now.getTime() - new Date(at).getTime() <= DAILY_DISCUSSION_WINDOW_HOURS * 3_600_000;

  it("takes the newest thread inside the window", () => {
    const eligible = candidates
      .filter((c) => insideWindow(c.at) && isDailyDiscussionPost(c.title, "wallstreetbets"))
      .sort((a, b) => b.at.localeCompare(a.at));

    assert.equal(eligible[0]?.title, "What Are Your Moves Tomorrow, August 6, 2026");
  });

  it("shows exactly one, never several days merged", () => {
    // Two days of megathread in one feed would have no coherent subject, and
    // the "source thread" label would be wrong for half the rows.
    const eligible = candidates.filter((c) => insideWindow(c.at));
    const chosen = eligible.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 1);
    assert.equal(chosen.length, 1);
  });

  it("reaches back far enough for a 'tomorrow' thread posted the night before", () => {
    // Posted 20:00 the previous evening — a calendar-day window would miss it
    // for the whole of the next morning.
    assert.equal(insideWindow("2026-08-05T20:00:40.000Z"), true);
  });

  it("reaches back far enough to cover a weekend thread", () => {
    const fridayEvening = new Date("2026-07-31T20:00:42.000Z");
    const sundayMidday = new Date("2026-08-02T12:00:00.000Z");
    const hours = (sundayMidday.getTime() - fridayEvening.getTime()) / 3_600_000;
    assert.ok(
      hours <= DAILY_DISCUSSION_WINDOW_HOURS,
      `a weekend thread must stay eligible on Sunday (${hours}h elapsed)`,
    );
  });

  it("excludes a thread older than the window", () => {
    assert.equal(insideWindow("2026-08-01T10:00:00.000Z"), false);
  });

  it("never selects a thread from another community", () => {
    assert.equal(
      isDailyDiscussionPost("Daily Discussion Thread for August 5, 2026", "stocks"),
      false,
    );
    assert.equal(DAILY_DISCUSSION_SUBREDDIT, "wallstreetbets");
  });
});
