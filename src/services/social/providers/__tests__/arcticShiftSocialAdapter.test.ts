import { stubFetch, testConfig } from "../../../../providers/reddit/__tests__/helpers.js";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ArcticShiftProvider } from "../../../../providers/reddit/ArcticShiftProvider.js";
import {
  __resetRuntimeConfigForTests,
  __setRuntimeConfigForTests,
  InactiveCommunityError,
} from "../../../reddit/redditRuntimeConfig.js";
import {
  archiveLagSeconds,
  ArcticShiftSocialSource,
} from "../arcticShiftSocialData.provider.js";

/**
 * THE ADAPTER THAT MAKES THE FREE ARCHIVE USABLE.
 *
 * Two classes of assertion here, and both are about silent failure:
 *
 *  - THE WIRE. `after`, `sort=asc` and a bounded `limit` are what make the
 *    request incremental. Get any of them wrong and the sync still "works" —
 *    it just re-downloads the same window forever, or walks backwards.
 *  - THE MAPPING. Several fields are load-bearing in ways that produce NO error
 *    when omitted: without `redditId` the comment stream finds no threads,
 *    without `flair` the Daily Discussion tab is empty, and with a non-ISO
 *    `createdAt` every ticker mention is silently dropped. Each gets a test.
 */

const COMMUNITY = "wallstreetbets";

/** A raw archive post, shaped exactly as the live API returns it. */
function rawPost(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1wef21l",
    created_utc: 1789225709,
    retrieved_on: 1789225739,
    author: "AdIndependent3751",
    subreddit: COMMUNITY,
    title: "Bad omen",
    selftext: "I am holding $NVDA calls",
    url: "https://i.redd.it/rp1s39llu3ph1.jpeg",
    link_flair_text: "Meme",
    score: 42,
    num_comments: 7,
    ...over,
  };
}

function rawComment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p9etgbe",
    created_utc: 1789242163,
    retrieved_on: 1789242193,
    author: "kal14144",
    subreddit: COMMUNITY,
    body: "Wendy's slander will not be tolerated",
    link_id: "t3_1wdr1cq",
    parent_id: "t1_p9estkx",
    score: 1,
    ...over,
  };
}

function source(): ArcticShiftSocialSource {
  return new ArcticShiftSocialSource(new ArcticShiftProvider(testConfig()));
}

beforeEach(() => {
  __resetRuntimeConfigForTests();
  __setRuntimeConfigForTests([COMMUNITY]);
});

describe("the request is genuinely incremental", () => {
  it("sends after, ascending order and a bounded limit", async () => {
    // ASCENDING IS NOT COSMETIC. The archive pages by timestamp; descending
    // walks away from the checkpoint into history we already hold, so the
    // window would never advance.
    const fetch = stubFetch(() => ({ body: { data: [rawPost()] } }));
    try {
      const after = new Date("2026-09-12T14:29:30Z");
      await source().fetchPosts({ community: COMMUNITY, after, limit: 100 });

      const url = new URL(fetch.urls[0] ?? "");
      assert.equal(url.pathname, "/api/posts/search");
      assert.equal(url.searchParams.get("subreddit"), COMMUNITY);
      assert.equal(url.searchParams.get("sort"), "asc");
      assert.equal(url.searchParams.get("limit"), "100");
      assert.equal(
        url.searchParams.get("after"),
        String(Math.floor(after.getTime() / 1000)),
        "after must be epoch seconds at the overlap-widened checkpoint",
      );
    } finally {
      fetch.restore();
    }
  });

  it("omits `after` on a cold start instead of sending a bogus epoch", async () => {
    // `after=0` would ask for the entire history of the community in one page.
    const fetch = stubFetch(() => ({ body: { data: [] } }));
    try {
      await source().fetchPosts({ community: COMMUNITY, after: null, limit: 100 });
      const url = new URL(fetch.urls[0] ?? "");
      assert.equal(url.searchParams.get("after"), null);
    } finally {
      fetch.restore();
    }
  });

  it("asks for only the columns the pipeline reads", async () => {
    // The full Reddit object is ~4 KB per record; the projection is a few
    // hundred bytes. `permalink` is deliberately absent — the live API rejects
    // it as a field, and the normalizer rebuilds it from the id.
    const fetch = stubFetch(() => ({ body: { data: [rawComment()] } }));
    try {
      await source().fetchComments({ community: COMMUNITY, after: null, limit: 100 });
      const fields = new URL(fetch.urls[0] ?? "").searchParams.get("fields") ?? "";
      for (const required of ["id", "created_utc", "body", "link_id", "retrieved_on"]) {
        assert.ok(fields.split(",").includes(required), `fields must request ${required}`);
      }
      assert.ok(!fields.includes("permalink"), "permalink is not a valid archive field");
    } finally {
      fetch.restore();
    }
  });

  it("makes exactly ONE request per call — never an internal paginate loop", async () => {
    // The general-purpose fetchPosts pages up to twenty times. A sync tick that
    // did that would be twenty requests against a free community service.
    const fetch = stubFetch(() => ({
      body: { data: Array.from({ length: 100 }, (_, i) => rawPost({ id: `p${i}` })) },
    }));
    try {
      const result = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 100 });
      assert.equal(fetch.urls.length, 1, "one call must mean one HTTP request");
      assert.equal(result.hasMore, true, "a full page must report that more is waiting");
    } finally {
      fetch.restore();
    }
  });

  it("sweeps the whole community when no thread is named", async () => {
    // This is what replaces the per-thread rotation: one request covers every
    // conversation, including ones a rotation would never have selected.
    const fetch = stubFetch(() => ({ body: { data: [rawComment()] } }));
    try {
      await source().fetchComments({ community: COMMUNITY, after: null, limit: 100 });
      const url = new URL(fetch.urls[0] ?? "");
      assert.equal(url.searchParams.get("link_id"), null, "no thread filter on a sweep");
      assert.equal(url.searchParams.get("subreddit"), COMMUNITY);
    } finally {
      fetch.restore();
    }
  });
});

describe("community scope is enforced on the free path too", () => {
  it("refuses a community that is not active, before any request is built", async () => {
    // Free does not mean unscoped. If the archive could be queried for any
    // community, the scope restriction on the metered path would be trivially
    // reintroduced through the cheap door.
    const fetch = stubFetch(() => ({ body: { data: [] } }));
    try {
      await assert.rejects(
        source().fetchPosts({ community: "someotherplace", after: null, limit: 10 }),
        InactiveCommunityError,
      );
      assert.equal(fetch.urls.length, 0, "not a single request may leave");
    } finally {
      fetch.restore();
    }
  });

  it("refuses every stream when the runtime config cannot be verified", async () => {
    __resetRuntimeConfigForTests();
    const fetch = stubFetch(() => ({ body: { data: [] } }));
    try {
      await assert.rejects(
        source().fetchComments({ community: COMMUNITY, after: null, limit: 10 }),
        InactiveCommunityError,
      );
      assert.equal(fetch.urls.length, 0);
    } finally {
      fetch.restore();
    }
  });
});

describe("post mapping — the fields that fail silently", () => {
  it("carries the reddit fullname, without which comment ingestion stops", async () => {
    // The comment stream selects threads with `redditId: { not: null }`. A post
    // stored without it is invisible to that query and nothing logs an error.
    const fetch = stubFetch(() => ({ body: { data: [rawPost()] } }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      assert.equal(items[0]?.redditId, "t3_1wef21l");
    } finally {
      fetch.restore();
    }
  });

  it("carries flair, without which the Daily Discussion tab stays empty", async () => {
    const fetch = stubFetch(() => ({
      body: { data: [rawPost({ link_flair_text: "Daily Discussion" })] },
    }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      assert.equal(items[0]?.flair, "Daily Discussion");
    } finally {
      fetch.restore();
    }
  });

  it("emits createdAt as a parseable ISO string, not an epoch", async () => {
    // The ticker-activity writer skips any item whose date does not parse, with
    // no error anywhere — every mention would vanish silently.
    const fetch = stubFetch(() => ({ body: { data: [rawPost()] } }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      const created = items[0]?.createdAt ?? "";
      assert.ok(!Number.isNaN(new Date(created).getTime()), "createdAt must parse");
      assert.equal(created, new Date(1789225709 * 1000).toISOString());
    } finally {
      fetch.restore();
    }
  });

  it("uses the BARE reddit id as the dedup key", async () => {
    const fetch = stubFetch(() => ({ body: { data: [rawPost()] } }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      assert.equal(items[0]?.id, "1wef21l", "no t3_ prefix on the upsert key");
    } finally {
      fetch.restore();
    }
  });

  it("keeps the thread permalink apart from the outbound link", async () => {
    // Conflating them puts "Open on Reddit" on a third-party page.
    const fetch = stubFetch(() => ({ body: { data: [rawPost()] } }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      assert.match(items[0]?.url ?? "", /reddit\.com\/r\/wallstreetbets\/comments\/1wef21l/);
      assert.equal(items[0]?.externalLink, "https://i.redd.it/rp1s39llu3ph1.jpeg");
    } finally {
      fetch.restore();
    }
  });

  it("anonymizes the author and never stores the username", async () => {
    const fetch = stubFetch(() => ({ body: { data: [rawPost()] } }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      assert.match(items[0]?.authorHash ?? "", /^anon_[0-9a-f]{12}$/);
      assert.ok(!JSON.stringify(items[0]).includes("AdIndependent3751"));
    } finally {
      fetch.restore();
    }
  });

  it("extracts tickers so the mention pipeline has something to validate", async () => {
    const fetch = stubFetch(() => ({ body: { data: [rawPost()] } }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      assert.ok(items[0]?.tickers.includes("NVDA"));
    } finally {
      fetch.restore();
    }
  });

  it("drops a record with neither title nor body rather than storing a ghost", async () => {
    const fetch = stubFetch(() => ({
      body: { data: [rawPost({ title: "", selftext: "" })] },
    }));
    try {
      const { items } = await source().fetchPosts({ community: COMMUNITY, after: null, limit: 10 });
      assert.equal(items.length, 0);
    } finally {
      fetch.restore();
    }
  });
});

describe("comment mapping", () => {
  it("routes to the comment table and points at its parent thread", async () => {
    // `postExternalId` must be the BARE parent id: the inheritance query
    // compares it against the parent post's reddit_id with the prefix stripped.
    const fetch = stubFetch(() => ({ body: { data: [rawComment()] } }));
    try {
      const { items } = await source().fetchComments({
        community: COMMUNITY,
        after: null,
        limit: 10,
      });
      assert.equal(items[0]?.type, "comment");
      assert.equal(items[0]?.postExternalId, "1wdr1cq", "bare, not t3_-prefixed");
      assert.equal(items[0]?.redditId, "t1_p9etgbe");
    } finally {
      fetch.restore();
    }
  });

  it("records the parent COMMENT for a reply", async () => {
    // parent_id = t1_… means the parent is another comment. This is the field
    // that makes a reply readable in the feed without opening Reddit.
    const fetch = stubFetch(() => ({
      body: { data: [rawComment({ parent_id: "t1_p9estkx" })] },
    }));
    try {
      const { items } = await source().fetchComments({
        community: COMMUNITY,
        after: null,
        limit: 10,
      });
      assert.equal(items[0]?.parentCommentId, "p9estkx", "bare id, to match external_id");
    } finally {
      fetch.restore();
    }
  });

  it("records NO parent comment for a top-level comment", async () => {
    // parent_id = t3_… means the parent is the POST itself. Storing that id as a
    // parent COMMENT would make every top-level comment look like a reply to
    // something that is not a comment — and thread membership is already
    // carried by postExternalId.
    const fetch = stubFetch(() => ({
      body: { data: [rawComment({ parent_id: "t3_1wdr1cq" })] },
    }));
    try {
      const { items } = await source().fetchComments({
        community: COMMUNITY,
        after: null,
        limit: 10,
      });
      assert.equal(items[0]?.parentCommentId, undefined);
      assert.equal(items[0]?.postExternalId, "1wdr1cq", "the thread is still recorded");
    } finally {
      fetch.restore();
    }
  });

  it("records no parent comment when the archive omits parent_id", async () => {
    const fetch = stubFetch(() => ({
      body: { data: [rawComment({ parent_id: undefined })] },
    }));
    try {
      const { items } = await source().fetchComments({
        community: COMMUNITY,
        after: null,
        limit: 10,
      });
      assert.equal(items[0]?.parentCommentId, undefined);
    } finally {
      fetch.restore();
    }
  });

  it("drops an empty-bodied comment", async () => {
    const fetch = stubFetch(() => ({ body: { data: [rawComment({ body: "" })] } }));
    try {
      const { items } = await source().fetchComments({
        community: COMMUNITY,
        after: null,
        limit: 10,
      });
      assert.equal(items.length, 0);
    } finally {
      fetch.restore();
    }
  });
});

describe("archive lag", () => {
  it("measures the archive's own indexing delay", () => {
    // retrieved_on - created_utc. This is what the fallback policy reads.
    assert.equal(archiveLagSeconds([rawPost()]), 30);
    assert.equal(archiveLagSeconds([rawComment()]), 30);
  });

  it("takes the MEDIAN so one re-indexed straggler cannot trigger a fallback", () => {
    const records = [
      rawPost({ created_utc: 1000, retrieved_on: 1010 }),
      rawPost({ created_utc: 2000, retrieved_on: 2020 }),
      rawPost({ created_utc: 3000, retrieved_on: 3030 }),
      // A month-old comment that was only just indexed. A max or a mean would
      // let this one row hand the stream to a metered provider.
      rawPost({ created_utc: 4000, retrieved_on: 4000 + 2_600_000 }),
    ];
    const lag = archiveLagSeconds(records);
    assert.ok(lag !== null && lag < 60, `median must ignore the outlier, got ${lag}`);
  });

  it("reports null — not zero — when lag cannot be measured", () => {
    // "No evidence of lag" and "no lag" are different claims, and a policy that
    // confused them would bench a healthy archive on missing data.
    assert.equal(archiveLagSeconds([{ id: "x", created_utc: 100 }]), null);
    assert.equal(archiveLagSeconds([]), null);
  });

  it("ignores a negative lag, which is a clock artifact", () => {
    assert.equal(archiveLagSeconds([rawPost({ created_utc: 500, retrieved_on: 100 })]), null);
  });
});
