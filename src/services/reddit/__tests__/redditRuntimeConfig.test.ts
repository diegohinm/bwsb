import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  CONFIG_GRACE_MS,
  InactiveCommunityError,
  __resetRuntimeConfigForTests,
  __setRuntimeConfigForTests,
  activeCommunities,
  assertCommunityIsActive,
  canRunRedditIngestion,
  runtimeConfigStatus,
} from "../redditRuntimeConfig.js";

/**
 * THE FAIL-CLOSED CONTRACT.
 *
 * The worker cannot read the backend's environment, so it asks — and every way
 * that ask can fail has to resolve toward spending LESS. The single rule these
 * tests exist to enforce:
 *
 *     a configuration failure must never widen Mindcase scope.
 *
 * The expensive mistake is not subtle. `catch { activeCommunities = ALL }` would
 * turn a backend restart into eight metered subreddits, and it would look
 * perfectly reasonable in review.
 */

beforeEach(() => __resetRuntimeConfigForTests());

describe("with no configuration ever loaded", () => {
  it("refuses to run ingestion", () => {
    assert.equal(canRunRedditIngestion(), false);
  });

  it("returns an EMPTY community list, not a default one", () => {
    // Callers iterate this, so "no authority" becomes "no requests" by
    // construction. There is no value it could return that widens scope.
    assert.deepEqual(activeCommunities(), []);
  });

  it("blocks Mindcase for any community at all", () => {
    for (const community of ["wallstreetbets", "options", "stocks"]) {
      assert.throws(
        () => assertCommunityIsActive(community),
        (err: unknown) => {
          assert.ok(err instanceof InactiveCommunityError);
          assert.match(err.message, /runtime configuration unavailable/);
          return true;
        },
        `${community} was not blocked`,
      );
    }
  });

  it("blocks even the community that would obviously be right", () => {
    // "We do not know what is active" and "this is not active" have the same
    // correct answer. Guessing correctly is still guessing.
    assert.throws(() => assertCommunityIsActive("wallstreetbets"), InactiveCommunityError);
  });
});

describe("with a freshly loaded configuration", () => {
  beforeEach(() => __setRuntimeConfigForTests(["wallstreetbets"]));

  it("runs ingestion for exactly the active communities", () => {
    assert.equal(canRunRedditIngestion(), true);
    assert.deepEqual(activeCommunities(), ["wallstreetbets"]);
  });

  it("permits the active community", () => {
    assert.doesNotThrow(() => assertCommunityIsActive("wallstreetbets"));
  });

  it("BLOCKS r/options before a request leaves", () => {
    assert.throws(
      () => assertCommunityIsActive("options"),
      (err: unknown) => {
        assert.ok(err instanceof InactiveCommunityError);
        assert.match(err.message, /blocked for inactive community: options/);
        return true;
      },
    );
  });

  it("blocks every other supported-but-inactive community", () => {
    for (const community of ["stocks", "investing", "pennystocks", "shortsqueeze"]) {
      assert.throws(
        () => assertCommunityIsActive(community),
        InactiveCommunityError,
        `${community} was not blocked`,
      );
    }
  });

  it("normalizes before comparing, so r/Options is blocked too", () => {
    assert.throws(() => assertCommunityIsActive("r/Options"), InactiveCommunityError);
    assert.doesNotThrow(() => assertCommunityIsActive("R/WallStreetBets"));
  });
});

describe("the grace window", () => {
  it("keeps working through a brief backend outage", () => {
    // A three-second network blip, or a backend restarting during a deploy,
    // must not create a gap in ingestion.
    __setRuntimeConfigForTests(["wallstreetbets"], 60_000);
    assert.equal(canRunRedditIngestion(), true);
    assert.doesNotThrow(() => assertCommunityIsActive("wallstreetbets"));
  });

  it("STOPS once the configuration is too old to trust", () => {
    __setRuntimeConfigForTests(["wallstreetbets"], CONFIG_GRACE_MS + 1_000);

    assert.equal(canRunRedditIngestion(), false);
    assert.deepEqual(activeCommunities(), []);
    assert.throws(() => assertCommunityIsActive("wallstreetbets"), InactiveCommunityError);
  });

  it("does not silently widen scope when it expires", () => {
    // The failure mode worth naming: an expiring config must not fall back to
    // the supported catalog. It falls back to nothing.
    __setRuntimeConfigForTests(["wallstreetbets"], CONFIG_GRACE_MS * 10);
    assert.deepEqual(activeCommunities(), []);
    assert.throws(() => assertCommunityIsActive("options"), InactiveCommunityError);
  });

  it("reports why it stopped", () => {
    __setRuntimeConfigForTests(["wallstreetbets"], CONFIG_GRACE_MS + 1);
    const status = runtimeConfigStatus();
    assert.equal(status.loaded, true);
    assert.equal(status.usable, false);
    assert.ok((status.ageSeconds ?? 0) > 0);
  });
});

describe("a multi-community configuration", () => {
  beforeEach(() => __setRuntimeConfigForTests(["wallstreetbets", "options"]));

  it("permits both, and still nothing else", () => {
    assert.doesNotThrow(() => assertCommunityIsActive("wallstreetbets"));
    assert.doesNotThrow(() => assertCommunityIsActive("options"));
    assert.throws(() => assertCommunityIsActive("stocks"), InactiveCommunityError);
  });

  it("ingests exactly what the backend said", () => {
    assert.deepEqual(activeCommunities(), ["wallstreetbets", "options"]);
  });
});
