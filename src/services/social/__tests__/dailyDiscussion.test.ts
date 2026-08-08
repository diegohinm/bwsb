import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyPostCategory,
  isDailyDiscussionPost,
  normalizeTitle,
} from "../dailyDiscussion.service.js";

/**
 * The titles carry a date, so every one of these uses a REAL title from the
 * database with its date intact — a classifier that only works on a stripped
 * form would pass a tidier test and fail in production.
 */

const wsb = (title: string, flair?: string) =>
  isDailyDiscussionPost(title, "wallstreetbets", flair);

describe("recognizing the daily threads", () => {
  it("matches 'What Are Your Moves Tomorrow'", () => {
    assert.equal(wsb("What Are Your Moves Tomorrow, August 6, 2026?"), true);
    assert.equal(wsb("What Are Your Moves Tomorrow, December 31, 2026?"), true);
  });

  it("matches 'What Are Your Moves Today'", () => {
    assert.equal(wsb("What Are Your Moves Today, August 6, 2026?"), true);
  });

  it("matches 'Daily Discussion Thread'", () => {
    assert.equal(wsb("Daily Discussion Thread for August 5, 2026"), true);
    assert.equal(wsb("Daily Discussion Thread"), true);
  });

  it("matches 'Weekend Discussion Thread'", () => {
    assert.equal(wsb("Weekend Discussion Thread for the Weekend of August 1-2"), true);
  });

  it("ignores case and irregular whitespace", () => {
    assert.equal(wsb("  what are YOUR   moves tomorrow, august 6, 2026? "), true);
    assert.equal(normalizeTitle("  A   B  "), "a b");
  });
});

describe("refusing ordinary posts", () => {
  it("does not match a regular post", () => {
    assert.equal(wsb("NVDA calls before earnings?"), false);
    assert.equal(wsb("My 400k YOLO update"), false);
    assert.equal(wsb("AMD beat on revenue, beat on EPS"), false);
  });

  it("requires the phrase at the START of the title", () => {
    // Otherwise an ordinary post ABOUT the thread drags its comments in.
    assert.equal(wsb("My thoughts on the daily discussion thread"), false);
    assert.equal(wsb("Reposting from what are your moves tomorrow"), false);
  });

  it("does not match a longer word that merely begins the same way", () => {
    assert.equal(wsb("Daily Discussion Threadbare portfolio review"), false);
  });

  it("handles a missing or empty title", () => {
    assert.equal(wsb(""), false);
    assert.equal(isDailyDiscussionPost(null, "wallstreetbets"), false);
    assert.equal(isDailyDiscussionPost(undefined, "wallstreetbets"), false);
  });
});

describe("scope is r/wallstreetbets only", () => {
  it("does not match the same title in another subreddit", () => {
    // r/stocks, r/investing and others run their own megathreads; treating them
    // as the same feature would silently blend communities.
    for (const sub of ["stocks", "investing", "options", "pennystocks"]) {
      assert.equal(
        isDailyDiscussionPost("Daily Discussion Thread for August 5, 2026", sub),
        false,
        `${sub} must not match`,
      );
      assert.equal(
        isDailyDiscussionPost("What Are Your Moves Tomorrow, August 6, 2026?", sub),
        false,
      );
    }
  });

  it("is case-insensitive about the subreddit name", () => {
    assert.equal(isDailyDiscussionPost("Daily Discussion Thread", "WallStreetBets"), true);
    assert.equal(isDailyDiscussionPost("Daily Discussion Thread", " wallstreetbets "), true);
  });

  it("handles a missing subreddit", () => {
    assert.equal(isDailyDiscussionPost("Daily Discussion Thread", null), false);
    assert.equal(isDailyDiscussionPost("Daily Discussion Thread", ""), false);
  });
});

describe("flair", () => {
  it("accepts a post the subreddit itself flaired as a daily thread", () => {
    // The subreddit's own classification beats inferring from prose.
    assert.equal(wsb("Some unusual title the pattern misses", "Daily Discussion"), true);
    assert.equal(wsb("Another one", "Weekend Discussion"), true);
    assert.equal(wsb("Another one", "Megathread"), true);
  });

  it("ignores an unrelated flair and falls back to the title", () => {
    assert.equal(wsb("NVDA calls before earnings?", "DD"), false);
    assert.equal(wsb("Daily Discussion Thread", "Discussion"), true);
  });

  it("never lets a flair override the subreddit scope", () => {
    assert.equal(isDailyDiscussionPost("anything", "stocks", "Daily Discussion"), false);
  });
});

describe("the stored category", () => {
  it("maps to the two values the column allows", () => {
    assert.equal(
      classifyPostCategory("What Are Your Moves Tomorrow, August 6, 2026?", "wallstreetbets"),
      "DAILY_DISCUSSION",
    );
    assert.equal(classifyPostCategory("NVDA calls", "wallstreetbets"), "REGULAR");
    assert.equal(classifyPostCategory("Daily Discussion Thread", "stocks"), "REGULAR");
  });
});

/**
 * The migration backfills existing rows with SQL that mirrors these patterns.
 * If the two ever drift, rows classified at ingestion and rows classified by
 * the backfill would disagree — so the exact titles the backfill was written
 * against are pinned here.
 */
describe("agreement with the backfill migration", () => {
  const titlesFromTheDatabase = [
    "What Are Your Moves Tomorrow, August 6, 2026",
    "Daily Discussion Thread for August 5, 2026",
    "What Are Your Moves Tomorrow, August 5, 2026",
    "Daily Discussion Thread for August 4, 2026",
    "Weekend Discussion Thread for the Weekend of August 1-2",
  ];

  it("classifies every real daily title the backfill selects", () => {
    for (const title of titlesFromTheDatabase) {
      assert.equal(wsb(title), true, `"${title}" was not recognized`);
    }
  });
});
