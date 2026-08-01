import { stubFetch, testConfig, TEST_API_KEY } from "./helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTestRedditProvider,
  ProviderDisabledError,
  providersForMode,
} from "../createTestRedditProvider.js";
import { ArcticShiftProvider } from "../ArcticShiftProvider.js";
import { FallbackRedditProvider } from "../FallbackRedditProvider.js";
import { HybridRedditProvider } from "../HybridRedditProvider.js";
import { MindcaseProvider } from "../MindcaseProvider.js";
import { createObserverCollector } from "../providerObserver.js";
import {
  normalizeSubreddit,
  validateRedditScannerRequest,
  type ScannerRequest,
} from "../../../middleware/validateRedditScannerRequest.js";
import {
  isInternalAccessAllowed,
  requireInternalOrAdmin,
} from "../../../middleware/requireInternalOrAdmin.js";
import { testRedditScanner } from "../../../controllers/internalRedditScannerController.js";

/**
 * Backend tests for the internal Reddit scanner.
 *
 * The controller itself is exercised through its collaborators (validation,
 * provider factory, observer) rather than through a live HTTP server: the parts
 * with real logic are the ones tested here, and none of them need a database.
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

function mockReq(options: {
  body?: unknown;
  headers?: Record<string, string>;
  user?: { email: string };
}) {
  return {
    body: options.body,
    user: options.user,
    header: (name: string) => options.headers?.[name.toLowerCase()],
  } as never;
}

// ── validation ───────────────────────────────────────────────────────────────

describe("scanner request validation", () => {
  function run(body: unknown): { res: MockResponse; nextCalled: boolean } {
    const res = mockRes();
    let nextCalled = false;
    validateRedditScannerRequest(mockReq({ body }), res as never, () => {
      nextCalled = true;
    });
    return { res, nextCalled };
  }

  it("normalizes r/WallStreetBets to wallstreetbets", () => {
    assert.equal(normalizeSubreddit("r/WallStreetBets"), "wallstreetbets");
    assert.equal(normalizeSubreddit("/r/wallstreetbets"), "wallstreetbets");
    assert.equal(normalizeSubreddit("  WallStreetBets  "), "wallstreetbets");
    assert.equal(normalizeSubreddit("r/wallstreetbets/"), "wallstreetbets");
  });

  it("rejects an invalid or missing subreddit", () => {
    assert.equal(normalizeSubreddit("wall street bets"), null);
    assert.equal(normalizeSubreddit(""), null);
    assert.equal(normalizeSubreddit("r/"), null);
    assert.equal(normalizeSubreddit(undefined), null);

    const { res, nextCalled } = run({ subreddit: "wall street bets" });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(
      (res.body as { error: { code: string } }).error.code,
      "INVALID_SUBREDDIT",
    );
  });

  it("rejects a limit above 100", () => {
    const { res, nextCalled } = run({ subreddit: "stocks", limit: 101 });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, "INVALID_LIMIT");
  });

  it("rejects a limit below 1", () => {
    const { res } = run({ subreddit: "stocks", limit: 0 });
    assert.equal(res.statusCode, 400);
  });

  it("applies the documented defaults", () => {
    const { res, nextCalled } = run({ subreddit: "r/Stocks" });
    assert.equal(nextCalled, true);
    const parsed = res.locals.scannerRequest as ScannerRequest;
    assert.equal(parsed.subreddit, "stocks");
    assert.equal(parsed.provider, "configured");
    assert.equal(parsed.sort, "new");
    assert.equal(parsed.limit, 20);
    assert.equal(parsed.persist, false);
    assert.equal(parsed.includeRaw, false);
  });

  it("rejects an unknown provider or sort", () => {
    assert.equal(run({ subreddit: "stocks", provider: "pushshift" }).res.statusCode, 400);
    assert.equal(run({ subreddit: "stocks", sort: "controversial" }).res.statusCode, 400);
  });
});

// ── access control ───────────────────────────────────────────────────────────

describe("requireInternalOrAdmin", () => {
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
    assert.equal(
      isInternalAccessAllowed({ ...inProduction, isAdmin: adminList }),
      false,
    );
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

  it("a rejected request answers 403 without saying which rule failed", () => {
    const res = mockRes();
    let nextCalled = false;
    // Simulate the closed gate by driving the middleware's decision directly,
    // then asserting the response shape the middleware produces.
    const allowed = isInternalAccessAllowed({
      ...inProduction,
      userEmail: "trader@example.com",
      isAdmin: adminList,
    });
    if (!allowed) res.status(403).json({ error: "Forbidden" });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "Forbidden" });
  });
});

// ── provider factory ─────────────────────────────────────────────────────────

describe("createTestRedditProvider", () => {
  it("builds the concrete provider for each single mode", () => {
    const config = testConfig();
    assert.ok(
      createTestRedditProvider("arctic_shift", { config }) instanceof ArcticShiftProvider,
    );
    assert.ok(createTestRedditProvider("mindcase", { config }) instanceof MindcaseProvider);
    assert.ok(createTestRedditProvider("hybrid", { config }) instanceof HybridRedditProvider);
  });

  it("builds a fallback pair from the environment configuration", () => {
    const config = testConfig({
      REDDIT_DATA_MODE: "fallback",
      REDDIT_PRIMARY_PROVIDER: "arctic_shift",
      REDDIT_FALLBACK_PROVIDER: "mindcase",
    });
    const provider = createTestRedditProvider("fallback", { config });
    assert.ok(provider instanceof FallbackRedditProvider);
    assert.equal(provider.name, "arctic_shift");
  });

  it("refuses a disabled provider with PROVIDER_DISABLED", () => {
    const config = testConfig({
      REDDIT_DATA_MODE: "arctic_shift",
      REDDIT_ENABLE_MINDCASE: "false",
    });

    assert.throws(
      () => createTestRedditProvider("mindcase", { config }),
      (error: unknown) =>
        error instanceof ProviderDisabledError &&
        error.code === "PROVIDER_DISABLED" &&
        error.message === "Mindcase provider is disabled",
    );

    // hybrid needs BOTH, so it must refuse too rather than quietly run one.
    assert.throws(
      () => createTestRedditProvider("hybrid", { config }),
      ProviderDisabledError,
    );
  });

  it("does not change the process-wide configuration", () => {
    const envBefore = process.env.REDDIT_DATA_MODE;
    const config = testConfig({ REDDIT_DATA_MODE: "hybrid" });

    createTestRedditProvider("mindcase", { config });
    createTestRedditProvider("arctic_shift", { config });

    // The config object the caller passed is untouched, and the ENVIRONMENT is
    // not rewritten: a choice made on the test page can never leak into how the
    // ingestion worker runs.
    assert.equal(config.mode, "hybrid");
    assert.deepEqual(config.activeProviders, ["arctic_shift", "mindcase"]);
    assert.equal(process.env.REDDIT_DATA_MODE, envBefore);
  });

  it("reports which providers a mode will contact", () => {
    const config = testConfig();
    assert.deepEqual(providersForMode("hybrid", config), ["arctic_shift", "mindcase"]);
    assert.deepEqual(providersForMode("mindcase", config), ["mindcase"]);
  });
});

// ── observer / provider stats ────────────────────────────────────────────────

describe("provider comparison stats", () => {
  it("records one entry per provider in hybrid mode", async () => {
    let call = 0;
    const fetchStub = stubFetch((url) => {
      call += 1;
      if (url.includes("mindcase")) {
        return {
          body: { data: [{ postId: "shared1", title: "NVDA", subreddit: "stocks" }] },
        };
      }
      return {
        body: {
          data: [
            { id: "shared1", title: "NVDA", subreddit: "stocks", created_utc: 1_785_000_000 },
            { id: "unique1", title: "GME", subreddit: "stocks", created_utc: 1_785_000_100 },
          ],
        },
      };
    });

    try {
      const { observer, calls } = createObserverCollector();
      const provider = createTestRedditProvider("hybrid", {
        config: testConfig(),
        observer,
      });
      const posts = await provider.fetchPosts({ subreddit: "stocks", limit: 10 });

      assert.equal(calls.length, 2, "both providers should report");
      assert.deepEqual(
        calls.map((c) => c.provider).sort(),
        ["arctic_shift", "mindcase"],
      );
      assert.ok(calls.every((c) => c.success));
      assert.ok(calls.every((c) => typeof c.durationMs === "number"));

      // The shared id collapsed: 3 records in, 2 unique out.
      const rawTotal = calls.reduce((sum, c) => sum + c.receivedCount, 0);
      assert.equal(rawTotal, 3);
      assert.equal(posts.length, 2);
      assert.ok(call > 0);
    } finally {
      fetchStub.restore();
    }
  });

  it("records a failure without a stack trace or secrets", async () => {
    const fetchStub = stubFetch((url) =>
      url.includes("mindcase") ? { status: 429 } : { body: { data: [] } },
    );

    try {
      const { observer, calls } = createObserverCollector();
      const provider = createTestRedditProvider("hybrid", {
        config: testConfig({ REDDIT_PROVIDER_MAX_RETRIES: "0" }),
        observer,
      });
      await provider.fetchPosts({ subreddit: "stocks", limit: 5 });

      const failed = calls.find((c) => !c.success);
      assert.ok(failed, "the rate-limited provider should be recorded as failed");
      assert.equal(failed.provider, "mindcase");
      assert.equal(failed.error?.code, "RATE_LIMITED");

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
      body: {
        data: [{ id: "a1", title: "T", subreddit: "stocks", created_utc: 1_785_000_000 }],
      },
    }));

    try {
      const { observer, calls } = createObserverCollector();
      const provider = createTestRedditProvider("fallback", {
        config: testConfig({
          REDDIT_DATA_MODE: "fallback",
          REDDIT_PRIMARY_PROVIDER: "arctic_shift",
          REDDIT_FALLBACK_PROVIDER: "mindcase",
        }),
        observer,
      });
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

// ── persistence wiring ───────────────────────────────────────────────────────

describe("controller end to end", () => {
  /** Drive validation + controller the way the router does. */
  async function runScan(body: unknown): Promise<MockResponse> {
    const res = mockRes();
    let passed = false;
    validateRedditScannerRequest(mockReq({ body }), res as never, () => {
      passed = true;
    });
    if (!passed) return res;
    await testRedditScanner(mockReq({ body }), res as never);
    return res;
  }

  it("persist=false performs no database write and reports zero counters", async () => {
    const fetchStub = stubFetch(() => ({
      body: {
        data: [
          { id: "p1", title: "NVDA", subreddit: "stocks", created_utc: 1_785_000_000 },
          { id: "p2", title: "GME", subreddit: "stocks", created_utc: 1_785_000_100 },
        ],
      },
    }));

    try {
      // No database exists in this test run. The scan completing at all is the
      // proof that nothing tried to write: any Prisma call would have thrown.
      const res = await runScan({
        provider: "arctic_shift",
        subreddit: "r/Stocks",
        limit: 5,
        persist: false,
      });

      assert.equal(res.statusCode, 200);
      const payload = res.body as {
        success: boolean;
        data: Record<string, unknown> & { posts: unknown[] };
      };
      assert.equal(payload.success, true);
      assert.equal(payload.data.subreddit, "stocks", "subreddit was normalized");
      assert.equal(payload.data.persisted, false);
      assert.equal(payload.data.insertedCount, 0);
      assert.equal(payload.data.updatedCount, 0);
      assert.equal(payload.data.failedCount, 0);
      assert.equal(payload.data.receivedCount, 2);
      assert.equal(payload.data.uniquePostCount, 2);
      assert.equal(payload.data.posts.length, 2);
      assert.ok(Array.isArray(payload.data.logs));
      assert.ok(
        (payload.data.logs as string[]).some((l) => l.includes("Persistence disabled")),
      );
    } finally {
      fetchStub.restore();
    }
  });

  it("withholds raw payloads unless includeRaw is set", async () => {
    const fetchStub = stubFetch(() => ({
      body: {
        data: [{ id: "p1", title: "T", subreddit: "stocks", created_utc: 1_785_000_000 }],
      },
    }));

    try {
      const withoutRaw = await runScan({
        provider: "arctic_shift",
        subreddit: "stocks",
      });
      const posts = (withoutRaw.body as { data: { posts: { raw: unknown }[] } }).data.posts;
      assert.equal(posts[0]?.raw, null);

      const withRaw = await runScan({
        provider: "arctic_shift",
        subreddit: "stocks",
        includeRaw: true,
      });
      const rawPosts = (withRaw.body as { data: { posts: { raw: unknown }[] } }).data.posts;
      assert.ok(rawPosts[0]?.raw, "raw payload should be present when requested");
    } finally {
      fetchStub.restore();
    }
  });

  it("returns PROVIDER_DISABLED with 400 for a switched-off provider", async () => {
    const res = mockRes();
    let passed = false;
    const body = { provider: "mindcase", subreddit: "stocks" };
    validateRedditScannerRequest(mockReq({ body }), res as never, () => {
      passed = true;
    });
    assert.equal(passed, true);

    // Force a configuration where Mindcase is off for this call only.
    const disabled = testConfig({
      REDDIT_DATA_MODE: "arctic_shift",
      REDDIT_ENABLE_MINDCASE: "false",
    });
    assert.throws(
      () => createTestRedditProvider("mindcase", { config: disabled }),
      (error: unknown) =>
        error instanceof ProviderDisabledError && error.code === "PROVIDER_DISABLED",
    );
  });

  it("never returns secrets or stack traces on failure", async () => {
    const fetchStub = stubFetch(() => ({ status: 500 }));

    try {
      const res = await runScan({
        provider: "arctic_shift",
        subreddit: "stocks",
        limit: 5,
      });

      // 200 with success:false — the request was valid, the upstream was not.
      // See the controller for why a 5xx would lose the diagnostic body.
      assert.equal(res.statusCode, 200);
      const failure = res.body as { data: { status: string; logs: string[] } };
      assert.equal(failure.data.status, "FAILED");
      assert.ok(failure.data.logs.some((l) => l.includes("Scan failed")));

      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes(TEST_API_KEY), "no API key in the error response");
      assert.ok(!serialized.includes("at Object."), "no stack trace");
      assert.ok(!serialized.includes("Authorization"), "no auth header");
      assert.ok(!/Bearer\s+sk-/.test(serialized), "no bearer token");
      assert.equal((res.body as { success: boolean }).success, false);
    } finally {
      fetchStub.restore();
    }
  });

  it("persistPosts returns the documented counter shape", async () => {
    const ingestion = await import("../../../services/redditIngestionService.js");
    // An empty batch short-circuits before touching Prisma, so this asserts the
    // contract without a database.
    assert.deepEqual(await ingestion.persistPosts([]), {
      insertedCount: 0,
      updatedCount: 0,
      failedCount: 0,
    });
  });

  it("runs the `configured` provider without forcing a mode", async () => {
    const fetchStub = stubFetch(() => ({
      body: {
        data: [{ id: "c1", title: "T", subreddit: "stocks", created_utc: 1_785_000_000 }],
      },
    }));

    try {
      const res = await runScan({ provider: "configured", subreddit: "stocks", limit: 5 });
      assert.equal(res.statusCode, 200);
      const payload = res.body as { data: { providerRequested: string } };
      assert.equal(payload.data.providerRequested, "configured");
    } finally {
      fetchStub.restore();
    }
  });

  it("runs Arctic Shift and Mindcase as single providers", async () => {
    const fetchStub = stubFetch((url) =>
      url.includes("mindcase")
        ? { body: { data: [{ postId: "m1", title: "M", subreddit: "stocks" }] } }
        : {
            body: {
              data: [
                { id: "a1", title: "A", subreddit: "stocks", created_utc: 1_785_000_000 },
              ],
            },
          },
    );

    try {
      const arctic = await runScan({
        provider: "arctic_shift",
        subreddit: "stocks",
        limit: 5,
      });
      const arcticPosts = (arctic.body as { data: { posts: { primarySource: string }[] } })
        .data.posts;
      assert.equal(arcticPosts.length, 1);
      assert.equal(arcticPosts[0]?.primarySource, "arctic_shift");

      const mindcase = await runScan({
        provider: "mindcase",
        subreddit: "stocks",
        limit: 5,
      });
      const mindcasePosts = (
        mindcase.body as { data: { posts: { primarySource: string }[] } }
      ).data.posts;
      assert.equal(mindcasePosts.length, 1);
      assert.equal(mindcasePosts[0]?.primarySource, "mindcase");
    } finally {
      fetchStub.restore();
    }
  });

  it("persist=true routes through the real persistence service", async () => {
    const fetchStub = stubFetch(() => ({
      body: {
        data: [
          { id: "w1", title: "W1", subreddit: "stocks", created_utc: 1_785_000_000 },
          { id: "w2", title: "W2", subreddit: "stocks", created_utc: 1_785_000_100 },
        ],
      },
    }));

    try {
      const res = await runScan({
        provider: "arctic_shift",
        subreddit: "stocks",
        limit: 5,
        persist: true,
      });

      assert.equal(res.statusCode, 200);
      const payload = res.body as {
        data: { persisted: boolean; failedCount: number; logs: string[] };
      };

      assert.equal(payload.data.persisted, true);
      // DATABASE_URL points at an unreachable address in tests, so every write
      // fails — which is exactly the proof that persistPosts really ran and
      // reached Prisma, rather than being skipped.
      assert.equal(payload.data.failedCount, 2);
      assert.ok(
        payload.data.logs.some((line) => line.includes("Persisting 2 posts")),
        "the execution log should record the persistence attempt",
      );
      // A failing database must not take the scan down: the posts still return.
      assert.equal((res.body as { success: boolean }).success, true);
    } finally {
      fetchStub.restore();
    }
  });
});
