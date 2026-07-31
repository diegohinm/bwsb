import {
  captureConsole,
  makePost,
  providerError,
  stubFetch,
  stubProvider,
  testConfig,
  TEST_API_KEY,
} from "./helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FallbackRedditProvider } from "../FallbackRedditProvider.js";
import { HybridRedditProvider } from "../HybridRedditProvider.js";
import { AllRedditProvidersFailedError } from "../providerErrors.js";
import { createRedditDataProvider } from "../RedditProviderFactory.js";

/**
 * The behaviour the whole feature exists for: REDDIT_DATA_MODE decides which
 * upstream is contacted, and nothing else has to change.
 *
 * The single-provider tests assert at the NETWORK level — which hosts were
 * actually requested — because "mode=arctic_shift never calls Mindcase" is a
 * claim about traffic, not about types.
 */
describe("REDDIT_DATA_MODE routing", () => {
  it("mode=mindcase calls Mindcase only", async () => {
    const fetchStub = stubFetch(() => ({
      body: { data: [{ postId: "abc123", title: "NVDA", subreddit: "wallstreetbets" }] },
    }));

    try {
      const provider = createRedditDataProvider(
        testConfig({ REDDIT_DATA_MODE: "mindcase" }),
      );
      const posts = await provider.fetchPosts({ subreddit: "wallstreetbets" });

      assert.equal(provider.name, "mindcase");
      assert.equal(posts.length, 1);
      assert.equal(posts[0]?.primarySource, "mindcase");
      assert.ok(fetchStub.urls.length > 0, "Mindcase should have been called");
      assert.ok(
        fetchStub.urls.every((url) => url.includes("api.mindcase.test")),
        `expected only Mindcase traffic, saw: ${fetchStub.urls.join(", ")}`,
      );
      assert.ok(
        fetchStub.urls.every((url) => !url.includes("arctic")),
        "Arctic Shift must never be contacted in mindcase mode",
      );
    } finally {
      fetchStub.restore();
    }
  });

  it("mode=arctic_shift calls Arctic Shift only", async () => {
    const fetchStub = stubFetch(() => ({
      body: {
        data: [
          {
            id: "abc123",
            title: "NVDA",
            subreddit: "wallstreetbets",
            created_utc: 1_785_000_000,
          },
        ],
      },
    }));

    try {
      const provider = createRedditDataProvider(
        testConfig({ REDDIT_DATA_MODE: "arctic_shift" }),
      );
      const posts = await provider.fetchPosts({ subreddit: "wallstreetbets" });

      assert.equal(provider.name, "arctic_shift");
      assert.equal(posts.length, 1);
      assert.equal(posts[0]?.primarySource, "arctic_shift");
      assert.ok(fetchStub.urls.length > 0, "Arctic Shift should have been called");
      assert.ok(
        fetchStub.urls.every((url) => url.includes("arctic.test")),
        `expected only Arctic Shift traffic, saw: ${fetchStub.urls.join(", ")}`,
      );
      assert.ok(
        fetchStub.urls.every((url) => !url.includes("mindcase")),
        "Mindcase must never be contacted in arctic_shift mode",
      );
    } finally {
      fetchStub.restore();
    }
  });

  it("mode=hybrid builds a composite over both providers", () => {
    const provider = createRedditDataProvider(
      testConfig({ REDDIT_DATA_MODE: "hybrid" }),
    );
    assert.ok(provider instanceof HybridRedditProvider);
  });

  it("mode=fallback builds a primary/secondary pair", () => {
    const provider = createRedditDataProvider(
      testConfig({
        REDDIT_DATA_MODE: "fallback",
        REDDIT_PRIMARY_PROVIDER: "arctic_shift",
        REDDIT_FALLBACK_PROVIDER: "mindcase",
      }),
    );
    assert.ok(provider instanceof FallbackRedditProvider);
    assert.equal(provider.name, "arctic_shift");
  });
});

describe("HybridRedditProvider", () => {
  const arcticPost = makePost({
    externalId: "abc123",
    primarySource: "arctic_shift",
    title: "NVDA is going to the moon",
    score: 100,
  });
  const mindcasePost = makePost({
    externalId: "abc123",
    primarySource: "mindcase",
    title: "NVDA is going to the moon",
    body: "Full DD content",
    score: 110,
  });
  const uniqueMindcasePost = makePost({
    externalId: "zzz999",
    primarySource: "mindcase",
    title: "GME squeeze",
  });

  it("queries every provider and merges the results", async () => {
    const arctic = stubProvider("arctic_shift", { posts: [arcticPost] });
    const mindcase = stubProvider("mindcase", {
      posts: [mindcasePost, uniqueMindcasePost],
    });

    const hybrid = new HybridRedditProvider([arctic, mindcase], {
      preferredSource: "arctic_shift",
    });
    const posts = await hybrid.fetchPosts({ subreddit: "wallstreetbets" });

    assert.equal(arctic.postCalls, 1);
    assert.equal(mindcase.postCalls, 1);
    // The shared post collapsed; the unique one survived.
    assert.equal(posts.length, 2);
    const merged = posts.find((p) => p.externalId === "abc123");
    assert.equal(merged?.body, "Full DD content");
    assert.deepEqual(merged?.sources, ["arctic_shift", "mindcase"]);
  });

  it("still returns data when Mindcase fails", async () => {
    const arctic = stubProvider("arctic_shift", { posts: [arcticPost] });
    const mindcase = stubProvider("mindcase", {
      error: providerError("mindcase", "rate_limit", 429),
    });

    const hybrid = new HybridRedditProvider([arctic, mindcase], {
      preferredSource: "arctic_shift",
    });
    const posts = await hybrid.fetchPosts({ subreddit: "wallstreetbets" });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.primarySource, "arctic_shift");
  });

  it("still returns data when Arctic Shift fails", async () => {
    const arctic = stubProvider("arctic_shift", {
      error: providerError("arctic_shift", "timeout"),
    });
    const mindcase = stubProvider("mindcase", { posts: [mindcasePost] });

    const hybrid = new HybridRedditProvider([arctic, mindcase], {
      preferredSource: "arctic_shift",
    });
    const posts = await hybrid.fetchPosts({ subreddit: "wallstreetbets" });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.body, "Full DD content");
  });

  it("throws only when every provider fails", async () => {
    const arctic = stubProvider("arctic_shift", {
      error: providerError("arctic_shift", "server", 503),
    });
    const mindcase = stubProvider("mindcase", {
      error: providerError("mindcase", "rate_limit", 429),
    });

    const hybrid = new HybridRedditProvider([arctic, mindcase], {
      preferredSource: "arctic_shift",
    });

    await assert.rejects(
      () => hybrid.fetchPosts({ subreddit: "wallstreetbets" }),
      AllRedditProvidersFailedError,
    );
    // A failing provider must not cancel the other one's request.
    assert.equal(arctic.postCalls, 1);
    assert.equal(mindcase.postCalls, 1);
  });
});

describe("FallbackRedditProvider", () => {
  const post = makePost({ externalId: "abc123", primarySource: "arctic_shift" });
  const backupPost = makePost({ externalId: "def456", primarySource: "mindcase" });

  it("does not call the secondary when the primary works", async () => {
    const primary = stubProvider("arctic_shift", { posts: [post] });
    const secondary = stubProvider("mindcase", { posts: [backupPost] });

    const provider = new FallbackRedditProvider(primary, secondary);
    const posts = await provider.fetchPosts({ subreddit: "wallstreetbets" });

    assert.equal(posts.length, 1);
    assert.equal(primary.postCalls, 1);
    assert.equal(secondary.postCalls, 0, "the secondary must stay untouched");
  });

  it("uses the secondary on HTTP 429", async () => {
    const primary = stubProvider("arctic_shift", {
      error: providerError("arctic_shift", "rate_limit", 429),
    });
    const secondary = stubProvider("mindcase", { posts: [backupPost] });

    const provider = new FallbackRedditProvider(primary, secondary);
    const posts = await provider.fetchPosts({ subreddit: "wallstreetbets" });

    assert.equal(posts[0]?.externalId, "def456");
    assert.equal(secondary.postCalls, 1);
  });

  it("uses the secondary on a timeout", async () => {
    const primary = stubProvider("arctic_shift", {
      error: providerError("arctic_shift", "timeout"),
    });
    const secondary = stubProvider("mindcase", { posts: [backupPost] });

    const provider = new FallbackRedditProvider(primary, secondary);
    const posts = await provider.fetchPosts({ subreddit: "wallstreetbets" });

    assert.equal(posts.length, 1);
    assert.equal(secondary.postCalls, 1);
  });

  it("uses the secondary on a 5xx and on a network error", async () => {
    for (const error of [
      providerError("arctic_shift", "server", 502),
      providerError("arctic_shift", "network"),
    ]) {
      const primary = stubProvider("arctic_shift", { error });
      const secondary = stubProvider("mindcase", { posts: [backupPost] });

      const provider = new FallbackRedditProvider(primary, secondary);
      await provider.fetchPosts({ subreddit: "wallstreetbets" });
      assert.equal(secondary.postCalls, 1);
    }
  });

  it("does NOT use the secondary on HTTP 400", async () => {
    const badRequest = providerError("arctic_shift", "client", 400);
    const primary = stubProvider("arctic_shift", { error: badRequest });
    const secondary = stubProvider("mindcase", { posts: [backupPost] });

    const provider = new FallbackRedditProvider(primary, secondary);

    await assert.rejects(
      () => provider.fetchPosts({ subreddit: "wallstreetbets" }),
      (error: unknown) => error === badRequest,
    );
    assert.equal(secondary.postCalls, 0, "a bad request must not be retried elsewhere");
  });

  it("falls back when the primary returns nothing, unless disabled", async () => {
    const empty = stubProvider("arctic_shift", { posts: [] });
    const secondary = stubProvider("mindcase", { posts: [backupPost] });

    const withFallback = new FallbackRedditProvider(empty, secondary);
    assert.equal(
      (await withFallback.fetchPosts({ subreddit: "wallstreetbets" })).length,
      1,
    );
    assert.equal(secondary.postCalls, 1);

    const strictSecondary = stubProvider("mindcase", { posts: [backupPost] });
    const withoutFallback = new FallbackRedditProvider(
      stubProvider("arctic_shift", { posts: [] }),
      strictSecondary,
      { fallbackOnEmpty: false },
    );
    assert.equal(
      (await withoutFallback.fetchPosts({ subreddit: "wallstreetbets" })).length,
      0,
    );
    assert.equal(strictSecondary.postCalls, 0);
  });

  it("logs which provider answered", async () => {
    const primary = stubProvider("arctic_shift", {
      error: providerError("arctic_shift", "rate_limit", 429),
    });
    const secondary = stubProvider("mindcase", { posts: [backupPost] });
    const provider = new FallbackRedditProvider(primary, secondary);

    const output = await captureConsole(async () => {
      await provider.fetchPosts({ subreddit: "wallstreetbets" });
    });

    assert.match(output, /Primary provider failed provider=arctic_shift/);
    assert.match(output, /Using fallback provider=mindcase/);
  });
});

describe("credential safety", () => {
  it("never writes the Mindcase API key to a log line", async () => {
    // Every failure path at once: 429, then 500, then an unparseable body.
    let call = 0;
    const responses = [
      { status: 429 },
      { status: 500 },
      { status: 200, body: { nothing: true } },
    ];
    const fetchStub = stubFetch(() => responses[call++ % responses.length] ?? {});

    try {
      const provider = createRedditDataProvider(
        testConfig({ REDDIT_DATA_MODE: "mindcase", REDDIT_PROVIDER_MAX_RETRIES: "2" }),
      );

      const output = await captureConsole(async () => {
        await provider
          .fetchPosts({ subreddit: "wallstreetbets" })
          .catch((error: unknown) => {
            // The error message is logged by callers, so it is part of the
            // surface being checked.
            console.error(error instanceof Error ? error.message : String(error));
          });
      });

      assert.ok(output.length > 0, "the failure should have produced log output");
      assert.ok(
        !output.includes(TEST_API_KEY),
        "the API key must never appear in log output",
      );
      assert.ok(!/Bearer\s+sk-/.test(output), "no Bearer token in log output");
    } finally {
      fetchStub.restore();
    }
  });

  it("redacts credential-shaped query parameters", async () => {
    const { redactUrl } = await import("../httpClient.js");
    assert.equal(
      redactUrl("https://api.example.test/x?api_key=SECRET&subreddit=stocks"),
      "https://api.example.test/x?api_key=***&subreddit=stocks",
    );
  });
});
