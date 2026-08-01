import { captureConsole, stubFetch, testConfig, TEST_API_KEY } from "./helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRedditDataConfig } from "../../../config/redditDataConfig.js";
import { MindcaseProvider } from "../MindcaseProvider.js";
import {
  buildRedditPostsPayload,
  extractValidationMessage,
  normalizeSubredditName,
  readAgentDefinition,
  suggestedInputFields,
} from "../mindcaseRedditRequest.js";
import { RedditProviderError } from "../providerErrors.js";
import { toObservedError } from "../providerObserver.js";

/**
 * The reddit/posts agent contract.
 *
 * These tests exist because the scanner's normalized request
 * (`{ provider, subreddit, sort, limit }`) was being sent to Mindcase verbatim
 * and answered with HTTP 422, and because the follow-up payload used
 * `startUrls`, which this account's agent rejects with
 * `"This agent needs input. Provide one of: URL"`.
 *
 * Three things are pinned here: the exact payload that goes on the wire (`URL`
 * as a string, never `startUrls`), the fact that exactly ONE request is made
 * per scan, and that a 422 reaches the operator as a readable sentence with no
 * credential in it.
 */

/** The keys the agent accepts. Anything else on the wire is a regression. */
const CONTRACT_KEYS = [
  "URL",
  "maxItems",
  "maxPostCount",
  "maxComments",
  "skipComments",
  "sort",
];

const INTERNAL_KEYS = ["provider", "subreddit", "limit", "persist", "includeRaw"];
/** Fields that must never appear: the array form the agent does not accept. */
const REJECTED_KEYS = ["startUrls", "urls", "searches"];

/** One usable record, in the shape Mindcase returns. */
const RECORD = { postId: "abc123", title: "NVDA calls", subreddit: "wallstreetbets" };

// ── payload construction ─────────────────────────────────────────────────────

describe("buildRedditPostsPayload", () => {
  it("sends the crawl target as a URL string, never an array", () => {
    const payload = buildRedditPostsPayload({
      subreddit: "wallstreetbets",
      sort: "new",
      limit: 20,
    });

    assert.equal(typeof payload.URL, "string");
    assert.equal(payload.URL, "https://www.reddit.com/r/wallstreetbets/new/");
    assert.ok(!Array.isArray(payload.URL));
  });

  it("never carries startUrls alongside URL", () => {
    const payload = buildRedditPostsPayload({ subreddit: "wallstreetbets" });
    for (const key of REJECTED_KEYS) {
      assert.equal(
        (payload as unknown as Record<string, unknown>)[key],
        undefined,
        `"${key}" must not be part of the payload`,
      );
    }
  });

  it("normalizes r/ prefixes, slashes and casing", () => {
    for (const input of [
      "r/wallstreetbets",
      "/r/WallStreetBets/",
      "  R/WALLSTREETBETS  ",
    ]) {
      assert.equal(normalizeSubredditName(input), "wallstreetbets", input);
      const payload = buildRedditPostsPayload({ subreddit: input, sort: "new" });
      assert.equal(
        payload.URL,
        "https://www.reddit.com/r/wallstreetbets/new/",
        input,
      );
    }
  });

  it("maps limit onto BOTH maxItems and maxPostCount", () => {
    const payload = buildRedditPostsPayload({ subreddit: "wallstreetbets", limit: 20 });
    assert.equal(payload.maxItems, 20);
    assert.equal(payload.maxPostCount, 20);
  });

  it("clamps the item count into [1, 100]", () => {
    const cases: [number | undefined, number][] = [
      [0, 1],
      [-5, 1],
      [1, 1],
      [100, 100],
      [500, 100],
      [20.7, 20],
    ];
    for (const [limit, expected] of cases) {
      const payload = buildRedditPostsPayload({ subreddit: "wallstreetbets", limit });
      assert.equal(payload.maxItems, expected, `limit=${limit}`);
      assert.equal(payload.maxPostCount, expected, `limit=${limit}`);
    }
  });

  it("scans posts only: skipComments with a zero comment budget", () => {
    const payload = buildRedditPostsPayload({ subreddit: "wallstreetbets" });
    assert.equal(payload.skipComments, true);
    assert.equal(payload.maxComments, 0);
  });

  it("accepts new, hot and top, and falls back to new", () => {
    const expected: Record<string, string> = {
      new: "https://www.reddit.com/r/wallstreetbets/new/",
      hot: "https://www.reddit.com/r/wallstreetbets/hot/",
      top: "https://www.reddit.com/r/wallstreetbets/top/",
    };

    for (const sort of ["new", "hot", "top"] as const) {
      const payload = buildRedditPostsPayload({ subreddit: "r/WallStreetBets", sort });
      assert.equal(payload.sort, sort);
      assert.equal(payload.URL, expected[sort], sort);
    }

    for (const sort of ["rising", "TOPP", "", undefined]) {
      const payload = buildRedditPostsPayload({ subreddit: "wallstreetbets", sort });
      assert.equal(payload.sort, "new", String(sort));
    }
  });

  it("carries the agent's fields and nothing else", () => {
    const payload = buildRedditPostsPayload({
      subreddit: "wallstreetbets",
      sort: "new",
      limit: 20,
    });
    assert.deepEqual(Object.keys(payload).sort(), [...CONTRACT_KEYS].sort());
  });
});

// ── what actually goes on the wire ───────────────────────────────────────────

describe("MindcaseProvider.fetchPosts request", () => {
  it("POSTs the agent payload to /agents/reddit/posts/run", async () => {
    const fetchStub = stubFetch(() => ({ body: { data: [RECORD] } }));
    try {
      const provider = new MindcaseProvider(testConfig());
      await provider.fetchPosts({ subreddit: "wallstreetbets", sort: "new", limit: 20 });

      const [request] = fetchStub.requests;
      assert.ok(request, "a request should have been sent");
      assert.equal(request.method, "POST");
      assert.ok(
        request.url.endsWith("/agents/reddit/posts/run"),
        `unexpected path: ${request.url}`,
      );
      assert.deepEqual(request.body, {
        URL: "https://www.reddit.com/r/wallstreetbets/new/",
        maxItems: 20,
        maxPostCount: 20,
        maxComments: 0,
        skipComments: true,
        sort: "new",
      });
    } finally {
      fetchStub.restore();
    }
  });

  it("never sends internal fields or startUrls", async () => {
    const fetchStub = stubFetch(() => ({ body: { data: [RECORD] } }));
    try {
      const provider = new MindcaseProvider(testConfig());
      await provider.fetchPosts({ subreddit: "r/wallstreetbets", sort: "top", limit: 20 });

      const sent = JSON.stringify(fetchStub.requests[0]?.body ?? {});
      for (const key of [...INTERNAL_KEYS, ...REJECTED_KEYS]) {
        assert.ok(!sent.includes(`"${key}"`), `field "${key}" was sent: ${sent}`);
      }
      assert.ok(sent.includes('"URL":"https://www.reddit.com/r/wallstreetbets/top/"'), sent);
    } finally {
      fetchStub.restore();
    }
  });

  it("calls the versioned root exactly once", async () => {
    const fetchStub = stubFetch(() => ({ body: { data: [RECORD] } }));
    try {
      const provider = new MindcaseProvider(
        testConfig({ MINDCASE_BASE_URL: "https://api.mindcase.test/api/v1" }),
      );
      await provider.fetchPosts({ subreddit: "wallstreetbets", limit: 20 });

      const url = fetchStub.urls[0] ?? "";
      assert.equal(
        url,
        "https://api.mindcase.test/api/v1/agents/reddit/posts/run",
        url,
      );
    } finally {
      fetchStub.restore();
    }
  });
});

describe("MINDCASE_BASE_URL normalization", () => {
  it("appends the API version when the operator omits it", () => {
    const config = buildRedditDataConfig({
      MINDCASE_BASE_URL: "https://api.mindcase.co",
    });
    assert.equal(config.mindcase.baseUrl, "https://api.mindcase.co/api/v1");
  });

  it("does not duplicate a version that is already there", () => {
    for (const value of [
      "https://api.mindcase.co/api/v1",
      "https://api.mindcase.co/api/v1/",
    ]) {
      const config = buildRedditDataConfig({ MINDCASE_BASE_URL: value });
      assert.equal(config.mindcase.baseUrl, "https://api.mindcase.co/api/v1", value);
    }
  });
});

// ── 422 handling ─────────────────────────────────────────────────────────────

/** The rejection this account actually sent when the payload used startUrls. */
const NEEDS_INPUT_BODY = {
  detail: "This agent needs input. Provide one of: URL",
};

const BAD_FIELD_BODY = {
  detail: [{ type: "value_error", loc: ["body", "URL"], msg: "URL must not be empty" }],
};

describe("HTTP 422 from the posts agent", () => {
  it("makes exactly one request — no speculative second payload", async () => {
    let call = 0;
    const fetchStub = stubFetch(() => {
      call += 1;
      return { status: 422, body: NEEDS_INPUT_BODY };
    });

    try {
      const provider = new MindcaseProvider(testConfig());
      const logs = await captureConsole(async () => {
        await assert.rejects(
          provider.fetchPosts({ subreddit: "wallstreetbets", limit: 20 }),
          (error: unknown) => {
            assert.ok(error instanceof RedditProviderError);
            assert.equal(error.kind, "upstream_validation");
            assert.equal(error.status, 422);
            return true;
          },
        );
      });

      // Probing alternative shapes could start duplicate jobs and spend credits.
      assert.equal(call, 1, "a rejected payload must never be re-sent in another shape");
      assert.ok(
        logs.includes("The agent asked for: URL"),
        `the requested input field should be surfaced: ${logs}`,
      );
    } finally {
      fetchStub.restore();
    }
  });

  it("keeps the validation message intact", async () => {
    let call = 0;
    const fetchStub = stubFetch(() => {
      call += 1;
      return { status: 422, body: BAD_FIELD_BODY };
    });

    try {
      const provider = new MindcaseProvider(testConfig());
      const logs = await captureConsole(async () => {
        await assert.rejects(
          provider.fetchPosts({ subreddit: "wallstreetbets", limit: 20 }),
          (error: unknown) => {
            assert.ok(error instanceof RedditProviderError);
            assert.equal(
              (error as RedditProviderError).message,
              "Mindcase rejected the request: URL must not be empty (body.URL)",
            );
            return true;
          },
        );
      });

      assert.equal(call, 1);
      assert.ok(
        logs.includes("URL must not be empty"),
        `the validation detail should be logged: ${logs}`,
      );
      assert.ok(logs.includes("sentInputField=URL"), `the sent field should be logged: ${logs}`);
    } finally {
      fetchStub.restore();
    }
  });

  it("reaches the scanner as a sanitized, stack-free error", async () => {
    const fetchStub = stubFetch(() => ({ status: 422, body: BAD_FIELD_BODY }));
    try {
      const provider = new MindcaseProvider(testConfig());
      await captureConsole(async () => {
        try {
          await provider.fetchPosts({ subreddit: "wallstreetbets", limit: 20 });
          assert.fail("expected the scan to fail");
        } catch (error) {
          const observed = toObservedError(error);
          assert.equal(observed.code, "UPSTREAM_VALIDATION_FAILED");
          assert.ok(observed.message.startsWith("Mindcase rejected the request: "));
          assert.deepEqual(Object.keys(observed).sort(), ["code", "message"]);
          assert.ok(!observed.message.includes("at "), "no stack frames");
        }
      });
    } finally {
      fetchStub.restore();
    }
  });

  it("never leaks the API key into a log line or an error message", async () => {
    // A hostile/naive upstream that echoes the Authorization header back.
    const fetchStub = stubFetch(() => ({
      status: 422,
      body: {
        detail: `invalid request (api_key=${TEST_API_KEY}, authorization: Bearer ${TEST_API_KEY})`,
      },
    }));

    try {
      const provider = new MindcaseProvider(testConfig());
      let message = "";
      const logs = await captureConsole(async () => {
        try {
          await provider.fetchPosts({ subreddit: "wallstreetbets", limit: 20 });
        } catch (error) {
          message = toObservedError(error).message;
        }
      });

      assert.ok(!logs.includes(TEST_API_KEY), `API key leaked into logs: ${logs}`);
      assert.ok(!message.includes(TEST_API_KEY), `API key leaked into response: ${message}`);
      assert.ok(!logs.includes("Bearer sk-"), "no bearer token in logs");
      assert.ok(message.startsWith("Mindcase rejected the request: "));
    } finally {
      fetchStub.restore();
    }
  });

  it("logs the run parameters without any credential", async () => {
    const fetchStub = stubFetch(() => ({ body: { data: [RECORD] } }));
    try {
      const provider = new MindcaseProvider(testConfig());
      const logs = await captureConsole(async () => {
        await provider.fetchPosts({ subreddit: "r/WallStreetBets", sort: "new", limit: 20 });
      });

      assert.ok(
        logs.includes("[MindcaseProvider] Running Reddit posts agent"),
        `missing the run banner: ${logs}`,
      );
      const logged = JSON.parse(
        /Running Reddit posts agent (\{.*?\})/.exec(logs)?.[1] ?? "{}",
      );
      assert.deepEqual(logged, {
        agent: "reddit/posts",
        inputField: "URL",
        url: "https://www.reddit.com/r/wallstreetbets/new/",
        maxItems: 20,
        sort: "new",
      });
      assert.ok(!logs.includes(TEST_API_KEY), "the API key must never be logged");
      assert.ok(!/authorization/i.test(logs), "no Authorization header in logs");
    } finally {
      fetchStub.restore();
    }
  });
});

// ── validation-body reading ──────────────────────────────────────────────────

describe("validation body parsing", () => {
  it("reads the shapes the API answers with", () => {
    assert.equal(
      extractValidationMessage(NEEDS_INPUT_BODY),
      "This agent needs input. Provide one of: URL",
    );
    assert.equal(extractValidationMessage(BAD_FIELD_BODY), "URL must not be empty (body.URL)");
    assert.equal(extractValidationMessage({ message: "bad input" }), "bad input");
    assert.equal(extractValidationMessage({ error: { message: "bad input" } }), "bad input");
    assert.equal(
      extractValidationMessage({ errors: [{ message: "a" }, { message: "b" }] }),
      "a; b",
    );
    assert.equal(extractValidationMessage({}), undefined);
    assert.equal(extractValidationMessage(undefined), undefined);
  });

  it("names the input fields the agent asked for", () => {
    assert.deepEqual(suggestedInputFields(NEEDS_INPUT_BODY), ["URL"]);
    assert.deepEqual(
      suggestedInputFields({ detail: "This agent needs input. Provide one of: URL, startUrls" }),
      ["URL", "startUrls"],
    );
    assert.deepEqual(suggestedInputFields(BAD_FIELD_BODY), []);
    assert.deepEqual(suggestedInputFields(undefined), []);
  });
});

// ── agent definition diagnostics ─────────────────────────────────────────────

describe("readAgentDefinition", () => {
  it("reads requiredParams however the account spells it", () => {
    assert.deepEqual(
      readAgentDefinition({ requiredParams: ["URL"], params: ["URL", "maxItems"] }),
      { requiredParams: ["URL"], allParams: ["URL", "maxItems"], matchesConfiguredInputField: true },
    );

    const schemaStyle = readAgentDefinition({
      agent: { schema: { required: ["startUrls"], properties: { startUrls: {}, sort: {} } } },
    });
    assert.deepEqual(schemaStyle.requiredParams, ["startUrls"]);
    assert.equal(
      schemaStyle.matchesConfiguredInputField,
      false,
      "an account declaring startUrls must be reported as a mismatch",
    );
  });

  it("says nothing rather than throwing on an unreadable payload", () => {
    for (const payload of [undefined, null, {}, "nope", 42]) {
      const definition = readAgentDefinition(payload);
      assert.deepEqual(definition.requiredParams, []);
      assert.deepEqual(definition.allParams, []);
      assert.equal(definition.matchesConfiguredInputField, false);
    }
  });
});

describe("MindcaseProvider.describeAgent", () => {
  it("reports the declared contract using GET requests only", async () => {
    const fetchStub = stubFetch((url) =>
      url.endsWith("/agents/reddit/posts")
        ? { body: { requiredParams: ["URL"], params: ["URL", "maxItems", "sort"] } }
        : { status: 404, body: { detail: "not found" } },
    );

    try {
      const provider = new MindcaseProvider(testConfig());
      let definition: Awaited<ReturnType<MindcaseProvider["describeAgent"]>> = null;
      const logs = await captureConsole(async () => {
        definition = await provider.describeAgent();
      });

      assert.deepEqual(definition, {
        requiredParams: ["URL"],
        allParams: ["URL", "maxItems", "sort"],
        matchesConfiguredInputField: true,
      });
      assert.ok(
        fetchStub.requests.every((request) => request.method === "GET"),
        "the inspector must never POST — a POST would create a billable job",
      );
      assert.ok(logs.includes("requiredParams=[URL]"), logs);
      assert.ok(!logs.includes(TEST_API_KEY), "the API key must never be logged");
    } finally {
      fetchStub.restore();
    }
  });

  it("returns null when the account publishes no definition", async () => {
    const fetchStub = stubFetch(() => ({ status: 404, body: { detail: "not found" } }));
    try {
      const provider = new MindcaseProvider(testConfig());
      let definition: unknown = "unset";
      await captureConsole(async () => {
        definition = await provider.describeAgent();
      });
      assert.equal(definition, null);
    } finally {
      fetchStub.restore();
    }
  });
});
