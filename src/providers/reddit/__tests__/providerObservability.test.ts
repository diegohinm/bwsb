import { stubFetch, testConfig, TEST_API_KEY } from "./helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ArcticShiftProvider } from "../ArcticShiftProvider.js";
import { FallbackRedditProvider } from "../FallbackRedditProvider.js";
import { HybridRedditProvider } from "../HybridRedditProvider.js";
import { MindcaseProvider } from "../MindcaseProvider.js";
import { createObserverCollector } from "../providerObserver.js";
import {
  isInternalAccessAllowed,
  requireInternalOrAdmin,
} from "../../../middleware/requireInternalOrAdmin.js";
import type { RedditDataConfig } from "../../../config/redditDataConfig.js";

/**
 * PRODUCTION provider behaviour: the observer, hybrid de-duplication, the
 * fallback short-circuit, and the internal-access gate.
 *
 * These cases used to live in `redditScanner.test.ts` and built their providers
 * through the manual scanner's factory. The scanner page is gone; the behaviour
 * they cover is not — the worker relies on all of it — so the providers are now
 * constructed directly and the coverage survives the deletion.
 *
 * `requireInternalOrAdmin` is kept here because it still guards the operator
 * diagnostics at /api/internal/reddit/*, which the scanner never owned.
 */

// ── minimal express doubles ──────────────────────────────────────────────────

type MockResponse = {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function mockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function mockReq(options: { headers?: Record<string, string>; user?: { email: string } }) {
  return {
    body: undefined,
    user: options.user,
    header: (name: string) => options.headers?.[name.toLowerCase()],
  } as never;
}

// ── provider builders (no scanner factory involved) ──────────────────────────

const arctic = (config: RedditDataConfig) => new ArcticShiftProvider(config);
const mindcase = (config: RedditDataConfig) => new MindcaseProvider(config);

describe("internal access gate", () => {
  // NODE_ENV is "test" here, which counts as non-production, so the middleware
  // is in its open state — that IS the development behaviour under test.
  it("development allows access", () => {
    const res = mockRes();
    let nextCalled = false;
    requireInternalOrAdmin(mockReq({}), res as never, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  // Production is exercised through the extracted decision function, so the
  // rules can be asserted without booting the app with NODE_ENV=production.
  const inProduction = { openByEnvironment: false } as const;
  const adminList = (email: string | null | undefined) => email === "ops@yolopulse.com";

  it("production rejects an anonymous caller", () => {
    assert.equal(isInternalAccessAllowed({ ...inProduction, isAdmin: adminList }), false);
  });

  it("production rejects a signed-in NON-admin user", () => {
    assert.equal(
      isInternalAccessAllowed({
        ...inProduction,
        userEmail: "trader@example.com",
        isAdmin: adminList,
      }),
      false,
    );
  });

  it("production allows an admin user", () => {
    assert.equal(
      isInternalAccessAllowed({
        ...inProduction,
        userEmail: "ops@yolopulse.com",
        isAdmin: adminList,
      }),
      true,
    );
  });

  it("production allows a correct x-admin-secret and rejects a wrong one", () => {
    assert.equal(
      isInternalAccessAllowed({
        ...inProduction,
        adminSecret: "s3cret",
        providedSecret: "s3cret",
        isAdmin: adminList,
      }),
      true,
    );
    assert.equal(
      isInternalAccessAllowed({
        ...inProduction,
        adminSecret: "s3cret",
        providedSecret: "guess",
        isAdmin: adminList,
      }),
      false,
    );
    // An unset ADMIN_SECRET must never be satisfiable by an absent header.
    assert.equal(
      isInternalAccessAllowed({
        ...inProduction,
        adminSecret: undefined,
        providedSecret: undefined,
        isAdmin: adminList,
      }),
      false,
    );
  });

  it("the email allowlist is case-insensitive and rejects unknown accounts", async () => {
    const { isAdminEmail } = await import("../../../config/adminAccess.js");
    assert.equal(isAdminEmail("nobody@example.com"), false);
    assert.equal(isAdminEmail(null), false);
    assert.equal(isAdminEmail(undefined), false);
  });
});

describe("provider comparison stats", () => {
  it("records one entry per provider in hybrid mode", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.includes("mindcase")) {
        return { body: { data: [{ postId: "shared1", title: "NVDA", subreddit: "stocks" }] } };
      }
      return {
        body: {
          data: [
            { id: "shared1", title: "NVDA", subreddit: "stocks", created_utc: 1_785_000_000 },
            { id: "other2", title: "MSFT", subreddit: "stocks", created_utc: 1_785_000_100 },
          ],
        },
      };
    });

    try {
      const config = testConfig();
      const { observer, calls } = createObserverCollector();
      const provider = new HybridRedditProvider([arctic(config), mindcase(config)], {
        preferredSource: "arctic_shift",
        deduplicate: true,
        observer,
      });
      const posts = await provider.fetchPosts({ subreddit: "stocks", limit: 10 });

      assert.equal(calls.length, 2, "both providers should report");
      assert.deepEqual(calls.map((c) => c.provider).sort(), ["arctic_shift", "mindcase"]);
      assert.ok(calls.every((c) => c.success));
      assert.ok(calls.every((c) => typeof c.durationMs === "number"));

      // The shared id collapsed: 3 records in, 2 unique out.
      const rawTotal = calls.reduce((sum, c) => sum + c.receivedCount, 0);
      assert.equal(rawTotal, 3);
      assert.equal(posts.length, 2);
    } finally {
      fetchStub.restore();
    }
  });

  it("records a failure without a stack trace or secrets", async () => {
    const fetchStub = stubFetch((url) =>
      url.includes("mindcase") ? { status: 429 } : { body: { data: [] } },
    );

    try {
      const config = testConfig({ REDDIT_PROVIDER_MAX_RETRIES: "0" });
      const { observer, calls } = createObserverCollector();
      const provider = new HybridRedditProvider([arctic(config), mindcase(config)], {
        preferredSource: "arctic_shift",
        observer,
      });
      await provider.fetchPosts({ subreddit: "stocks", limit: 5 });

      const failed = calls.find((c) => !c.success);
      assert.ok(failed, "the rate-limited provider should be recorded as failed");
      assert.equal(failed.provider, "mindcase");
      assert.equal(failed.error?.code, "RATE_LIMITED");

      // Provider stats are surfaced to operators, so they must stay clean.
      const serialized = JSON.stringify(calls);
      assert.ok(!serialized.includes(TEST_API_KEY), "no API key in provider stats");
      assert.ok(!serialized.includes("at Object."), "no stack trace in provider stats");
      assert.ok(!/Bearer\s+sk-/.test(serialized), "no bearer token in provider stats");
    } finally {
      fetchStub.restore();
    }
  });

  it("does not call the secondary in fallback mode when the primary answers", async () => {
    const fetchStub = stubFetch(() => ({
      body: { data: [{ id: "a1", title: "T", subreddit: "stocks", created_utc: 1_785_000_000 }] },
    }));

    try {
      const config = testConfig({
        REDDIT_DATA_MODE: "fallback",
        REDDIT_PRIMARY_PROVIDER: "arctic_shift",
        REDDIT_FALLBACK_PROVIDER: "mindcase",
      });
      const { observer, calls } = createObserverCollector();
      const provider = new FallbackRedditProvider(arctic(config), mindcase(config), { observer });
      await provider.fetchPosts({ subreddit: "stocks", limit: 5 });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.provider, "arctic_shift");
      assert.ok(
        fetchStub.urls.every((url) => !url.includes("mindcase")),
        "Mindcase must not be contacted when the primary works",
      );
    } finally {
      fetchStub.restore();
    }
  });
});
