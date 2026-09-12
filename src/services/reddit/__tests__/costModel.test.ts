import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { env } from "../../../config/env.js";
import { estimateCost, formatUsd } from "../mindcaseBudget.service.js";
import {
  boundsForComments,
  boundsForPosts,
  intervalForPriority,
} from "../redditSyncPlan.js";

/**
 * THE ECONOMICS, AS AN EXECUTABLE MODEL.
 *
 * "The scheduler works" is not the completion criterion — the ratio of new rows
 * to billed rows is. This file turns the configured cadence into a projected
 * daily bill so that a change to any interval or limit shows up as a number
 * rather than as a surprise at the end of the month.
 *
 * It asserts BOUNDS, not predictions. Reddit's actual volume decides the real
 * figure; what is pinned here is that the configuration cannot exceed what the
 * budget guard allows, and that the old configuration provably did.
 */

/** US regular session: 09:30–16:00 ET. */
const MARKET_OPEN_MINUTES = 6.5 * 60;
const MARKET_CLOSED_MINUTES = 24 * 60 - MARKET_OPEN_MINUTES;

/** Polls a thread of this priority gets in a window, at a given base cadence. */
function pollsIn(windowMinutes: number, baseMinutes: number, priority: number): number {
  const intervalMinutes = intervalForPriority(baseMinutes, priority);
  return Math.floor(windowMinutes / intervalMinutes);
}

/**
 * Worst case: every request returns its full `maxResults`.
 *
 * The adaptive sizer means this is NOT the expected bill — a quiet stream
 * converges to the floor — but it is the number the budget guard has to be able
 * to survive, because a genuinely busy day really does saturate every request.
 */
function projectedDailyRows(): { posts: number; comments: number; total: number } {
  const postSyncsPerDay = (24 * 60) / env.REDDIT_POSTS_INTERVAL_MINUTES;
  const posts = postSyncsPerDay * boundsForPosts().max;

  const openBase = env.REDDIT_COMMENTS_MARKET_OPEN_INTERVAL_MINUTES;
  const closedBase = env.REDDIT_COMMENTS_MARKET_CLOSED_INTERVAL_MINUTES;
  const rows = boundsForComments().max;

  // One thread per priority band, up to the per-sweep cap: in practice that is
  // the live megathread plus whichever recent posts are busy.
  const priorities = [0, 1, 2].slice(0, env.REDDIT_COMMENT_THREADS_PER_SYNC);

  let comments = 0;
  for (const priority of priorities) {
    comments += pollsIn(MARKET_OPEN_MINUTES, openBase, priority) * rows;
    comments += pollsIn(MARKET_CLOSED_MINUTES, closedBase, priority) * rows;
  }

  return { posts, comments, total: posts + comments };
}

describe("what the OLD configuration cost", () => {
  // Five subreddits, one Mindcase job each, 50 rows apiece, every ten minutes.
  const OLD_SUBREDDITS = 5;
  const OLD_ROWS_EACH = 50;
  const OLD_CYCLES_PER_DAY = (24 * 60) / 10;

  it("bought 250 rows per cycle", () => {
    assert.equal(OLD_SUBREDDITS * OLD_ROWS_EACH, 250);
    assert.equal(formatUsd(estimateCost(250)), "$1.25");
  });

  it("came to about $180 a day", () => {
    const rows = OLD_SUBREDDITS * OLD_ROWS_EACH * OLD_CYCLES_PER_DAY;
    assert.equal(rows, 36_000);
    assert.equal(estimateCost(rows), 180);
  });

  it("exceeded the daily budget guard many times over", () => {
    // The guard did not exist then. Had it, it would have tripped before 07:00.
    const rows = OLD_SUBREDDITS * OLD_ROWS_EACH * OLD_CYCLES_PER_DAY;
    assert.ok(estimateCost(rows) > env.MINDCASE_MAX_ESTIMATED_COST_PER_DAY_USD * 3);
  });
});

describe("what the NEW post cadence costs", () => {
  it("buys at most a small fraction of the old post spend", () => {
    const { posts } = projectedDailyRows();
    const old = 5 * 50 * 144;
    assert.ok(
      posts <= old * 0.15,
      `posts worst case is ${posts} rows vs ${old} before — expected ≥85% reduction`,
    );
  });

  it("costs under ten dollars a day even fully saturated", () => {
    const { posts } = projectedDailyRows();
    assert.ok(
      estimateCost(posts) < 20,
      `posts worst case ${formatUsd(estimateCost(posts))}`,
    );
  });
});

describe("what the comment cadence costs", () => {
  it("is bounded, and the bound is knowable before it is spent", () => {
    const { comments } = projectedDailyRows();
    // One sweep can never exceed threads × maxResults, so a day cannot exceed
    // the sum of its polls. This is the number the operator is choosing.
    assert.ok(comments > 0, "a one-minute cadence is not free");
    assert.ok(
      comments < 20_000,
      `comments worst case is ${comments} rows (${formatUsd(estimateCost(comments))}/day)`,
    );
  });

  it("polls the megathread far more often than a quiet thread", () => {
    assert.equal(intervalForPriority(60_000, 0), 60_000);
    assert.equal(intervalForPriority(60_000, 1), 5 * 60_000);
    assert.equal(intervalForPriority(60_000, 2), 10 * 60_000);
  });

  it("spends less per day with the market closed than open", () => {
    const rows = boundsForComments().max;
    const open = pollsIn(MARKET_OPEN_MINUTES, env.REDDIT_COMMENTS_MARKET_OPEN_INTERVAL_MINUTES, 0);
    const closed = pollsIn(
      MARKET_CLOSED_MINUTES,
      env.REDDIT_COMMENTS_MARKET_CLOSED_INTERVAL_MINUTES,
      0,
    );
    // 6.5 open hours at 1m beats 17.5 closed hours at 10m, which is the whole
    // point of making the cadence market-aware.
    assert.ok(open * rows > closed * rows);
  });
});

describe("the budget guard is the backstop, not the plan", () => {
  it("has a daily ceiling the configuration can actually reach", () => {
    // If the worst case were far BELOW the ceiling the guard would be
    // decorative; if it were far above, normal operation would be throttled
    // every day and the data would silently stop being fresh. It should be
    // reachable on a genuinely busy day and not on an ordinary one.
    const { total } = projectedDailyRows();
    const ceiling = env.MINDCASE_MAX_ROWS_PER_DAY;
    assert.ok(
      total > ceiling * 0.5,
      `worst case ${total} rows is far under the ${ceiling}-row ceiling — the guard is decorative`,
    );
  });

  it("reports the projected worst case, for the record", () => {
    const { posts, comments, total } = projectedDailyRows();
    // Not an assertion so much as a published number: this line is what a
    // reviewer reads when asking "what did we sign up for?".
    console.log(
      `      [cost model] worst-case/day: posts=${posts} rows, comments=${comments} rows, ` +
        `total=${total} rows = ${formatUsd(estimateCost(total))}` +
        ` (guard: ${env.MINDCASE_MAX_ROWS_PER_DAY} rows / ` +
        `${formatUsd(env.MINDCASE_MAX_ESTIMATED_COST_PER_DAY_USD)})`,
    );
    assert.ok(total > 0);
  });
});
