import { makeComment, makePost } from "./helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deduplicateComments,
  deduplicatePosts,
} from "../deduplicateRedditData.js";

describe("deduplicateRedditData", () => {
  it("merges the same post from both providers into one record", () => {
    // The worked example from the specification.
    const fromArcticShift = makePost({
      externalId: "abc123",
      primarySource: "arctic_shift",
      title: "NVDA is going to the moon",
      body: null,
      score: 100,
    });
    const fromMindcase = makePost({
      externalId: "abc123",
      primarySource: "mindcase",
      title: "NVDA is going to the moon",
      body: "Full DD content",
      score: 110,
    });

    const [merged, ...rest] = deduplicatePosts(
      [fromArcticShift, fromMindcase],
      { preferredSource: "arctic_shift" },
    );

    assert.equal(rest.length, 0, "the two records must collapse into one");
    assert.ok(merged);
    assert.equal(merged.externalId, "abc123");
    assert.equal(merged.title, "NVDA is going to the moon");
    assert.equal(merged.body, "Full DD content");
    assert.equal(merged.score, 110);
    assert.equal(merged.primarySource, "arctic_shift");
    assert.deepEqual(merged.sources, ["arctic_shift", "mindcase"]);
  });

  it("keeps the fullest body and never regresses to null", () => {
    const withBody = makePost({
      externalId: "p1",
      primarySource: "mindcase",
      body: "A long and complete due-diligence write-up",
    });
    const withoutBody = makePost({
      externalId: "p1",
      primarySource: "arctic_shift",
      body: null,
    });

    // Order must not matter: null can never win.
    for (const pair of [
      [withBody, withoutBody],
      [withoutBody, withBody],
    ]) {
      const [merged] = deduplicatePosts(pair);
      assert.equal(merged?.body, "A long and complete due-diligence write-up");
    }
  });

  it("takes volatile metrics from the more recently fetched record", () => {
    const older = makePost({
      externalId: "p2",
      primarySource: "arctic_shift",
      score: 500,
      commentCount: 40,
      fetchedAt: new Date("2026-07-30T10:00:00.000Z"),
    });
    // A later fetch saw the score DROP — "most recent" must win over "highest".
    const newer = makePost({
      externalId: "p2",
      primarySource: "mindcase",
      score: 120,
      commentCount: 51,
      fetchedAt: new Date("2026-07-30T14:00:00.000Z"),
    });

    const [merged] = deduplicatePosts([older, newer]);
    assert.equal(merged?.score, 120);
    assert.equal(merged?.commentCount, 51);
  });

  it("combines the sources array with the preferred provider first", () => {
    const a = makePost({ externalId: "p3", primarySource: "mindcase" });
    const b = makePost({ externalId: "p3", primarySource: "arctic_shift" });

    const [preferArctic] = deduplicatePosts([a, b], {
      preferredSource: "arctic_shift",
    });
    assert.deepEqual(preferArctic?.sources, ["arctic_shift", "mindcase"]);
    assert.equal(preferArctic?.primarySource, "arctic_shift");

    const [preferMindcase] = deduplicatePosts([a, b], {
      preferredSource: "mindcase",
    });
    assert.deepEqual(preferMindcase?.sources, ["mindcase", "arctic_shift"]);
    assert.equal(preferMindcase?.primarySource, "mindcase");
  });

  it("does not invent duplicates or drop distinct posts", () => {
    const posts = deduplicatePosts([
      makePost({ externalId: "a", primarySource: "mindcase" }),
      makePost({ externalId: "b", primarySource: "arctic_shift" }),
      makePost({ externalId: "a", primarySource: "arctic_shift" }),
      makePost({ externalId: "c", primarySource: "mindcase" }),
    ]);

    assert.deepEqual(posts.map((p) => p.externalId), ["a", "b", "c"]);
  });

  it("keeps the earliest creation time — a post is not created twice", () => {
    const early = makePost({
      externalId: "p4",
      primarySource: "arctic_shift",
      createdAt: new Date("2026-07-30T08:00:00.000Z"),
    });
    const lateApproximation = makePost({
      externalId: "p4",
      primarySource: "mindcase",
      createdAt: new Date("2026-07-30T09:30:00.000Z"),
    });

    const [merged] = deduplicatePosts([lateApproximation, early]);
    assert.equal(merged?.createdAt.toISOString(), "2026-07-30T08:00:00.000Z");
  });

  it("deduplicates comments by externalId and merges their sources", () => {
    const fromArcticShift = makeComment({
      externalId: "xyz789",
      primarySource: "arctic_shift",
      body: null,
      score: 12,
    });
    const fromMindcase = makeComment({
      externalId: "xyz789",
      primarySource: "mindcase",
      body: "Positions or ban",
      score: 15,
    });

    const merged = deduplicateComments([fromArcticShift, fromMindcase], {
      preferredSource: "arctic_shift",
    });

    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.body, "Positions or ban");
    assert.equal(merged[0]?.score, 15);
    assert.equal(merged[0]?.primarySource, "arctic_shift");
    assert.deepEqual(merged[0]?.sources, ["arctic_shift", "mindcase"]);
  });

  it("keeps distinct comments apart", () => {
    const merged = deduplicateComments([
      makeComment({ externalId: "c1", primarySource: "mindcase" }),
      makeComment({ externalId: "c2", primarySource: "mindcase" }),
      makeComment({ externalId: "c1", primarySource: "arctic_shift" }),
    ]);
    assert.deepEqual(merged.map((c) => c.externalId), ["c1", "c2"]);
  });
});
