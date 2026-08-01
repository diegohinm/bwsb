import "../../providers/reddit/__tests__/helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertRedditSubredditsUsable,
  buildRedditConfig,
  MIN_POLL_INTERVAL_MS,
  normalizeSubreddit,
  parseSubreddits,
  RedditSubredditConfigError,
} from "../reddit.config.js";
import { internalRedditRouter } from "../../routes/internalReddit.routes.js";

/**
 * REDDIT_SUBREDDITS is the single source of truth for which communities the
 * product monitors. These tests pin the two things that make that safe: the
 * normalization is total (a pasted URL and a typed `r/` name land on the same
 * value), and a malformed list stops the worker instead of silently ingesting
 * a subset.
 */

describe("subreddit normalization", () => {
  it("accepts every shape an operator plausibly pastes", () => {
    const cases: [string, string][] = [
      ["wallstreetbets", "wallstreetbets"],
      ["  stocks  ", "stocks"],
      ["r/stocks", "stocks"],
      ["/r/Options/", "options"],
      ["https://www.reddit.com/r/options/", "options"],
      ["https://reddit.com/r/PennyStocks", "pennystocks"],
      ["ValueInvesting", "valueinvesting"],
      ["stocks?sort=new", "stocks"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeSubreddit(input), expected, input);
    }
  });

  it("splits, trims, lowercases and de-duplicates while keeping order", () => {
    assert.deepEqual(
      parseSubreddits("wallstreetbets, r/Stocks ,https://www.reddit.com/r/options/,STOCKS"),
      ["wallstreetbets", "stocks", "options"],
    );
  });

  it("returns an empty list for an absent or blank value", () => {
    assert.deepEqual(parseSubreddits(undefined), []);
    assert.deepEqual(parseSubreddits(""), []);
    assert.deepEqual(parseSubreddits(" , , "), []);
  });

  it("rejects names that are not subreddits", () => {
    const config = buildRedditConfig({
      REDDIT_SUBREDDITS: "wallstreetbets,wall street bets,/r/,https://google.com",
    });
    assert.deepEqual(config.subreddits, ["wallstreetbets"]);
    assert.deepEqual(
      [...config.invalidSubreddits],
      ["wall street bets", "/r/", "https://google.com"],
    );
  });
});

describe("worker startup gate", () => {
  it("names the rejected value instead of ingesting a subset", () => {
    const config = buildRedditConfig({
      REDDIT_SUBREDDITS: "wallstreetbets,wall street bets",
    });
    assert.throws(
      () => assertRedditSubredditsUsable(config),
      (error: unknown) => {
        assert.ok(error instanceof RedditSubredditConfigError);
        assert.equal(
          error.message,
          'Invalid subreddit in REDDIT_SUBREDDITS: "wall street bets"',
        );
        return true;
      },
    );
  });

  it("refuses to start on an explicitly empty list", () => {
    const config = buildRedditConfig({ REDDIT_SUBREDDITS: "" });
    assert.deepEqual(config.subreddits, []);
    assert.throws(
      () => assertRedditSubredditsUsable(config),
      /must contain at least one subreddit/,
    );
  });

  it("falls back to the tracked catalog when the variable is absent", () => {
    const config = buildRedditConfig({});
    assert.equal(config.source, "catalog");
    assert.ok(config.subreddits.includes("wallstreetbets"));
    // The catalog is normalized on the way through — no mixed casing leaks.
    assert.deepEqual(
      config.subreddits.filter((name) => name !== name.toLowerCase()),
      [],
    );
    assert.doesNotThrow(() => assertRedditSubredditsUsable(config));
  });
});

describe("pacing knobs", () => {
  it("defaults to five minutes and refuses anything faster", () => {
    assert.equal(buildRedditConfig({}).pollIntervalMs, MIN_POLL_INTERVAL_MS);
    assert.equal(
      buildRedditConfig({ REDDIT_POLL_INTERVAL_MS: "1000" }).pollIntervalMs,
      MIN_POLL_INTERVAL_MS,
      "a value below the floor must be raised, never honoured",
    );
    assert.equal(
      buildRedditConfig({ REDDIT_POLL_INTERVAL_MS: "600000" }).pollIntervalMs,
      600_000,
    );
  });

  it("accepts the ARCTIC_SHIFT_* aliases, with REDDIT_* winning", () => {
    assert.equal(
      buildRedditConfig({ ARCTIC_SHIFT_POST_LIMIT: "50" }).postLimit,
      50,
    );
    assert.equal(
      buildRedditConfig({ ARCTIC_SHIFT_POST_LIMIT: "50", REDDIT_POST_LIMIT: "75" }).postLimit,
      75,
    );
  });

  it("is frozen — nothing can push, splice or sort the shared list", () => {
    const config = buildRedditConfig({ REDDIT_SUBREDDITS: "stocks,options" });
    assert.throws(() => (config.subreddits as string[]).push("gme"));
    assert.deepEqual(config.subreddits, ["stocks", "options"]);
  });
});

describe("GET /api/internal/reddit/config", () => {
  /** Find the handler stack the router registered for a path. */
  function layerFor(path: string): { handleCount: number; handler: Function } {
    const layers = (internalRedditRouter as unknown as {
      stack: { route?: { path: string; stack: { handle: Function }[] } }[];
    }).stack;
    const route = layers.find((layer) => layer.route?.path === path)?.route;
    assert.ok(route, `no route registered for ${path}`);
    const handler = route.stack[route.stack.length - 1]?.handle;
    assert.ok(handler);
    return { handleCount: route.stack.length, handler };
  }

  it("is registered behind a guard middleware", () => {
    const { handleCount } = layerFor("/internal/reddit/config");
    assert.ok(handleCount >= 2, "the config route must sit behind requireInternalOrAdmin");
  });

  it("returns configuration only — no key, token or URL", () => {
    const { handler } = layerFor("/internal/reddit/config");
    let payload: Record<string, unknown> | undefined;
    const res = {
      status() {
        return res;
      },
      json(body: { data?: Record<string, unknown> }) {
        payload = body.data;
        return res;
      },
    };

    handler({}, res, () => {});
    assert.ok(payload, "the endpoint answered nothing");

    assert.deepEqual(
      Object.keys(payload).sort(),
      [
        "pollIntervalMs",
        "postLimit",
        "providerMode",
        "source",
        "subreddits",
        "workerEnabled",
      ],
    );

    const serialized = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ["key", "token", "secret", "authorization", "http"]) {
      assert.ok(
        !serialized.includes(forbidden),
        `the config endpoint leaked something matching "${forbidden}": ${serialized}`,
      );
    }
  });
});
