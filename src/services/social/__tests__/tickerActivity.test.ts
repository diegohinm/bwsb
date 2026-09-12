import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUCKET_MINUTES,
  UNKNOWN_SUBREDDIT,
  bucketStartFor,
  foldEntries,
  type ActivityEntry,
} from "../tickerActivity.service.js";

/**
 * The arithmetic behind Top Tickers and Hot Tickers.
 *
 * The writes themselves need a database; what is pinned here is everything that
 * decides WHAT is written — which bucket a mention lands in, and what a batch of
 * mentions adds up to. Both are pure, and both are places where a subtle error
 * would produce numbers that look plausible and are wrong.
 */

const at = (iso: string) => new Date(iso);

const mention = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ticker: "NVDA",
  subreddit: "wallstreetbets",
  sourceType: "COMMENT",
  stance: "neutral",
  authorHash: "author-1",
  occurredAt: at("2026-09-11T15:07:42.000Z"),
  ...over,
});

describe("bucket boundaries", () => {
  it("floors a timestamp to its five-minute bucket", () => {
    assert.equal(
      bucketStartFor(at("2026-09-11T15:07:42.000Z")).toISOString(),
      "2026-09-11T15:05:00.000Z",
    );
  });

  it("keeps a timestamp that is already a boundary", () => {
    assert.equal(
      bucketStartFor(at("2026-09-11T15:05:00.000Z")).toISOString(),
      "2026-09-11T15:05:00.000Z",
    );
  });

  it("puts the last millisecond of a bucket in that bucket, not the next", () => {
    assert.equal(
      bucketStartFor(at("2026-09-11T15:09:59.999Z")).toISOString(),
      "2026-09-11T15:05:00.000Z",
    );
  });

  it("anchors to the epoch, so an hour divides into exactly twelve buckets", () => {
    const starts = new Set<string>();
    for (let minute = 0; minute < 60; minute += 1) {
      const iso = `2026-09-11T15:${String(minute).padStart(2, "0")}:30.000Z`;
      starts.add(bucketStartFor(at(iso)).toISOString());
    }
    assert.equal(starts.size, 60 / BUCKET_MINUTES);
  });
});

describe("folding a batch into bucket deltas", () => {
  it("collapses mentions of one ticker in one bucket into a single delta", () => {
    const folded = foldEntries([
      mention({ occurredAt: at("2026-09-11T15:05:10.000Z") }),
      mention({ occurredAt: at("2026-09-11T15:09:50.000Z") }),
    ]);

    assert.equal(folded.size, 1);
    const [delta] = [...folded.values()];
    assert.equal(delta.mentions, 2);
    assert.equal(delta.bucketStart.toISOString(), "2026-09-11T15:05:00.000Z");
  });

  it("separates buckets that only differ by five minutes", () => {
    const folded = foldEntries([
      mention({ occurredAt: at("2026-09-11T15:04:59.000Z") }),
      mention({ occurredAt: at("2026-09-11T15:05:01.000Z") }),
    ]);
    assert.equal(folded.size, 2);
  });

  it("separates the same ticker in different communities", () => {
    const folded = foldEntries([
      mention({ subreddit: "wallstreetbets" }),
      mention({ subreddit: "stocks" }),
    ]);
    assert.equal(folded.size, 2);
  });

  it("counts posts and comments separately, and both as mentions", () => {
    const [delta] = [
      ...foldEntries([
        mention({ sourceType: "POST" }),
        mention({ sourceType: "COMMENT" }),
        mention({ sourceType: "COMMENT" }),
      ]).values(),
    ];

    assert.equal(delta.mentions, 3);
    assert.equal(delta.posts, 1);
    assert.equal(delta.comments, 2);
  });

  it("keeps the sentiment split summing to the mention count", () => {
    const [delta] = [
      ...foldEntries([
        mention({ stance: "bullish" }),
        mention({ stance: "bearish" }),
        mention({ stance: "neutral" }),
        // Unclassified and unrecognized both land in neutral rather than
        // vanishing — otherwise the three columns would not add up, and a share
        // taken of them would silently exceed 100%.
        mention({ stance: null }),
        mention({ stance: "confused" }),
      ]).values(),
    ];

    assert.equal(delta.mentions, 5);
    assert.equal(delta.bullish, 1);
    assert.equal(delta.bearish, 1);
    assert.equal(delta.neutral, 3);
    assert.equal(delta.bullish + delta.neutral + delta.bearish, delta.mentions);
  });

  it("normalizes the symbol, so $nvda and NVDA are one ticker", () => {
    const folded = foldEntries([mention({ ticker: "nvda" }), mention({ ticker: "NVDA" })]);
    assert.equal(folded.size, 1);
    assert.equal([...folded.values()][0].ticker, "NVDA");
  });

  it("files a mention with no community under the sentinel instead of dropping it", () => {
    const [delta] = [...foldEntries([mention({ subreddit: null })]).values()];
    assert.equal(delta.subreddit, UNKNOWN_SUBREDDIT);
    assert.equal(delta.mentions, 1);
  });
});
