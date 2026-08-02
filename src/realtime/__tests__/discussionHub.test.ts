import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { discussionHub } from "../discussionHub.js";
import {
  DISCUSSION_EVENT_TYPES,
  toAuthorHandle,
  toPreview,
  toSentiment,
  type DiscussionEvent,
  type DiscussionFrame,
} from "../discussionEvents.js";

/**
 * The hub is the seam that makes the feed provider-agnostic, so what matters is
 * that it routes by TICKER, never leaks between subscribers, and survives one
 * broken listener. Those three properties are what let a future push adapter
 * replace the current source without anything downstream noticing.
 *
 * The normalizers get the same treatment for a different reason: they are the
 * last place a Reddit username could leak, and the place a missing body could
 * turn into a fabricated preview.
 */

function samplePost(ticker: string): DiscussionEvent {
  return {
    type: "newPost",
    ticker,
    at: new Date().toISOString(),
    post: {
      id: `${ticker}-1`,
      ticker,
      subreddit: "wallstreetbets",
      author: "anon_abc123",
      title: "title",
      preview: "preview",
      upvotes: 1,
      commentCount: 0,
      sentiment: "bullish",
      permalink: null,
      createdAt: new Date().toISOString(),
    },
  };
}

describe("discussion hub routing", () => {
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("delivers only to subscribers of that ticker", () => {
    const msft: DiscussionFrame[] = [];
    const nvda: DiscussionFrame[] = [];
    cleanups.push(discussionHub.subscribe("MSFT", (f) => msft.push(f)));
    cleanups.push(discussionHub.subscribe("NVDA", (f) => nvda.push(f)));

    discussionHub.publish(samplePost("MSFT"));

    assert.equal(msft.length, 1);
    assert.equal(nvda.length, 0, "a NVDA watcher must never see MSFT traffic");
  });

  it("is case-insensitive about the symbol", () => {
    const seen: DiscussionFrame[] = [];
    cleanups.push(discussionHub.subscribe("msft", (f) => seen.push(f)));
    discussionHub.publish(samplePost("MSFT"));
    assert.equal(seen.length, 1);
  });

  it("fans out to every subscriber of the same ticker", () => {
    let a = 0;
    let b = 0;
    cleanups.push(discussionHub.subscribe("AMD", () => (a += 1)));
    cleanups.push(discussionHub.subscribe("AMD", () => (b += 1)));

    discussionHub.publish(samplePost("AMD"));

    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  it("stops delivering after unsubscribe and forgets the ticker", () => {
    const seen: DiscussionFrame[] = [];
    const stop = discussionHub.subscribe("TSLA", (f) => seen.push(f));
    discussionHub.publish(samplePost("TSLA"));
    stop();
    discussionHub.publish(samplePost("TSLA"));

    assert.equal(seen.length, 1);
    assert.equal(discussionHub.watchedTickers().includes("TSLA"), false);
  });

  it("keeps serving the others when one listener throws", () => {
    let survivor = 0;
    cleanups.push(
      discussionHub.subscribe("AAPL", () => {
        throw new Error("broken socket");
      }),
    );
    cleanups.push(discussionHub.subscribe("AAPL", () => (survivor += 1)));

    assert.doesNotThrow(() => discussionHub.publish(samplePost("AAPL")));
    assert.equal(survivor, 1);
  });

  it("publishing to nobody is free and reports no watchers", () => {
    assert.doesNotThrow(() => discussionHub.publish(samplePost("ZZZZ")));
    assert.equal(discussionHub.subscriberCount("ZZZZ"), 0);
  });
});

describe("discussion event vocabulary", () => {
  it("covers the six event types the contract promises", () => {
    assert.deepEqual(
      [...DISCUSSION_EVENT_TYPES],
      [
        "newPost",
        "updatedPost",
        "newComment",
        "updatedComment",
        "deletedPost",
        "deletedComment",
      ],
    );
  });
});

describe("normalizers", () => {
  it("maps stance to the three-way classification", () => {
    assert.equal(toSentiment("bullish"), "bullish");
    assert.equal(toSentiment("bearish"), "bearish");
    assert.equal(toSentiment("neutral"), "neutral");
    // Anything unread or unrecognized displays as neutral.
    assert.equal(toSentiment(null), "neutral");
    assert.equal(toSentiment(undefined), "neutral");
    assert.equal(toSentiment("wildly optimistic"), "neutral");
  });

  it("truncates a preview and never invents one", () => {
    assert.equal(toPreview(null), "");
    assert.equal(toPreview(undefined), "");
    assert.equal(toPreview("   "), "");
    assert.equal(toPreview("short body"), "short body");
    assert.equal(toPreview("a\n\nb   c"), "a b c");

    const long = "x".repeat(400);
    const preview = toPreview(long, 240);
    assert.ok(preview.length <= 241, "the ellipsis is the only thing added");
    assert.ok(preview.endsWith("…"));
  });

  it("shortens the author hash without ever producing a Reddit username", () => {
    assert.equal(toAuthorHandle("anon_a3f91c2d5e07"), "anon_a3f91c");
    assert.equal(toAuthorHandle(null), "anon");
    assert.equal(toAuthorHandle(undefined), "anon");
    // The handle is stable — the same hash always yields the same label.
    assert.equal(toAuthorHandle("anon_a3f91c2d5e07"), toAuthorHandle("anon_a3f91c2d5e07"));
    // ...and it is derived only from the stored hash, so no raw name can appear.
    assert.ok(!toAuthorHandle("anon_a3f91c2d5e07").startsWith("u/"));
  });
});
