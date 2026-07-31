import "./helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeArcticShiftComment,
  normalizeArcticShiftPost,
  normalizeMindcaseComment,
  normalizeMindcasePost,
  toBareId,
} from "../normalizeRedditData.js";

const FETCHED_AT = new Date("2026-07-30T20:00:00.000Z");

describe("normalizeRedditData", () => {
  it("strips t3_/t1_ prefixes so both id forms collapse to one key", () => {
    assert.equal(toBareId("t3_abc123"), "abc123");
    assert.equal(toBareId("abc123"), "abc123");
    assert.equal(toBareId("t1_xyz789"), "xyz789");
    assert.equal(toBareId("xyz789"), "xyz789");
    assert.equal(toBareId(null), null);
  });

  it("normalizes an Arctic Shift post", () => {
    const post = normalizeArcticShiftPost(
      {
        id: "abc123",
        name: "t3_abc123",
        subreddit: "wallstreetbets",
        author: "yolo_trader",
        title: "NVDA calls",
        selftext: "Full DD content",
        permalink: "/r/wallstreetbets/comments/abc123/nvda_calls/",
        url: "https://i.redd.it/x.png",
        score: 420,
        upvote_ratio: 0.97,
        num_comments: 69,
        created_utc: 1_785_000_000,
      },
      { fetchedAt: FETCHED_AT },
    );

    assert.ok(post);
    assert.equal(post.externalId, "abc123");
    assert.equal(post.fullname, "t3_abc123");
    assert.equal(post.author, "yolo_trader");
    assert.equal(post.body, "Full DD content");
    assert.equal(post.score, 420);
    assert.equal(post.upvoteRatio, 0.97);
    assert.equal(post.commentCount, 69);
    assert.equal(post.createdAt.getTime(), 1_785_000_000 * 1000);
    assert.equal(post.primarySource, "arctic_shift");
    assert.deepEqual(post.sources, ["arctic_shift"]);
  });

  it("treats deleted authors and tombstoned bodies as null", () => {
    const post = normalizeArcticShiftPost({
      id: "t3_deleted1",
      subreddit: "stocks",
      author: "[deleted]",
      title: "Gone",
      selftext: "[removed]",
      created_utc: 1_785_000_000,
    });

    assert.equal(post?.author, null);
    assert.equal(post?.body, null);
  });

  it("builds a permalink when the upstream omits one", () => {
    const post = normalizeMindcasePost(
      { postId: "abc123", title: "No permalink here" },
      { subreddit: "options" },
    );
    assert.equal(post?.permalink, "/r/options/comments/abc123/");
  });

  it("normalizes a Mindcase post despite different field names", () => {
    const post = normalizeMindcasePost(
      {
        postId: "t3_abc123",
        subreddit: "r/wallstreetbets",
        username: "diamond_hands",
        title: "NVDA calls",
        text: "Full DD content",
        postUrl: "https://www.reddit.com/r/wallstreetbets/comments/abc123/nvda/",
        upvotes: 410,
        comments: 68,
        posted: "2026-07-30T12:00:00.000Z",
      },
      { fetchedAt: FETCHED_AT },
    );

    assert.ok(post);
    // The `t3_` form collapses to the same key Arctic Shift produced.
    assert.equal(post.externalId, "abc123");
    assert.equal(post.subreddit, "wallstreetbets");
    assert.equal(post.author, "diamond_hands");
    assert.equal(post.body, "Full DD content");
    assert.equal(post.score, 410);
    assert.equal(post.commentCount, 68);
    assert.equal(post.createdAt.toISOString(), "2026-07-30T12:00:00.000Z");
    assert.equal(post.primarySource, "mindcase");
    // An absolute reddit.com URL is reduced to its path.
    assert.equal(post.permalink, "/r/wallstreetbets/comments/abc123/nvda/");
  });

  it("normalizes comments from both providers onto the same shape", () => {
    const fromArcticShift = normalizeArcticShiftComment(
      {
        id: "t1_xyz789",
        subreddit: "wallstreetbets",
        link_id: "t3_abc123",
        parent_id: "t3_abc123",
        author: "bagholder",
        body: "Positions or ban",
        score: 15,
        created_utc: 1_785_000_100,
      },
      { fetchedAt: FETCHED_AT },
    );
    const fromMindcase = normalizeMindcaseComment(
      {
        commentId: "xyz789",
        subreddit: "wallstreetbets",
        postId: "abc123",
        commentText: "Positions or ban",
        score: 16,
        created: 1_785_000_100,
      },
      { fetchedAt: FETCHED_AT },
    );

    assert.equal(fromArcticShift?.externalId, "xyz789");
    assert.equal(fromMindcase?.externalId, "xyz789");
    assert.equal(fromArcticShift?.postId, "abc123");
    assert.equal(fromMindcase?.postId, "abc123");
    // parentId keeps its fullname prefix — it is the only thing that says
    // whether the parent is the post or another comment.
    assert.equal(fromArcticShift?.parentId, "t3_abc123");
  });

  it("returns null for a record with no usable id rather than throwing", () => {
    assert.equal(normalizeArcticShiftPost({ title: "no id" }), null);
    assert.equal(normalizeMindcasePost(null), null);
    assert.equal(normalizeArcticShiftComment("not an object"), null);
  });

  it("reads seconds, milliseconds and ISO timestamps alike", () => {
    const seconds = normalizeArcticShiftPost({ id: "a", created_utc: 1_785_000_000 });
    const millis = normalizeArcticShiftPost({ id: "b", created_utc: 1_785_000_000_000 });
    const iso = normalizeMindcasePost({ id: "c", posted: "2026-07-30T12:00:00Z" });

    assert.equal(seconds?.createdAt.getTime(), 1_785_000_000_000);
    assert.equal(millis?.createdAt.getTime(), 1_785_000_000_000);
    assert.equal(iso?.createdAt.toISOString(), "2026-07-30T12:00:00.000Z");
  });
});
