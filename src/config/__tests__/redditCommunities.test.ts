import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVE_REDDIT_COMMUNITIES,
  ALLOW_REDDIT_COMMUNITY_SELECTION,
  DEFAULT_ACTIVE_COMMUNITY,
  InvalidRedditCommunityError,
  SUPPORTED_REDDIT_COMMUNITIES,
  activeCommunityOptions,
  effectiveCommunitiesFromQuery,
  isActiveCommunity,
  normalizeCommunity,
  parseRedditCommunities,
  resolveEffectiveRedditCommunities,
} from "../redditCommunities.js";

/**
 * THE SINGLE SOURCE OF TRUTH, under test.
 *
 * Every case here is a way the old arrangement could go wrong: a typo silently
 * narrowing scope, a missing variable silently widening it, or a query string
 * reaching a community nobody meant to pay for.
 */

describe("normalizing what an operator might type", () => {
  it("accepts the plain name", () => {
    assert.equal(normalizeCommunity("wallstreetbets"), "wallstreetbets");
  });

  it("strips an r/ prefix, whitespace and casing", () => {
    assert.equal(normalizeCommunity("  R/WallStreetBets  "), "wallstreetbets");
    assert.equal(normalizeCommunity("/r/Options/"), "options");
  });

  it("accepts a pasted URL", () => {
    assert.equal(
      normalizeCommunity("https://www.reddit.com/r/wallstreetbets/"),
      "wallstreetbets",
    );
  });

  it("produces the documented example", () => {
    assert.deepEqual(parseRedditCommunities("wallstreetbets, r/options"), [
      "wallstreetbets",
      "options",
    ]);
  });

  it("removes duplicates however they were spelled", () => {
    assert.deepEqual(
      parseRedditCommunities("wallstreetbets,R/WallStreetBets, wallstreetbets"),
      ["wallstreetbets"],
    );
  });
});

describe("parsing the variable", () => {
  it("reads a single community", () => {
    assert.deepEqual(parseRedditCommunities("wallstreetbets"), ["wallstreetbets"]);
  });

  it("reads several", () => {
    assert.deepEqual(parseRedditCommunities("wallstreetbets,options"), [
      "wallstreetbets",
      "options",
    ]);
  });

  it("FAILS on an unsupported community instead of ignoring it", () => {
    // A silently dropped typo is the worst outcome available: the operator
    // believes two communities are active, one is, and nothing says so until
    // somebody compares a dashboard against an invoice.
    assert.throws(
      () => parseRedditCommunities("wallstreetbets,banana123"),
      (err: unknown) => {
        assert.ok(err instanceof InvalidRedditCommunityError);
        assert.match(err.message, /Invalid Reddit community configured: banana123/);
        return true;
      },
    );
  });

  it("falls back to ONE community when unset — never to all supported", () => {
    // The expensive mistake would be resolving an unset variable to the full
    // catalog: a missing line in a .env becoming eight metered subreddits.
    assert.deepEqual(parseRedditCommunities(undefined), [DEFAULT_ACTIVE_COMMUNITY]);
    assert.deepEqual(parseRedditCommunities(""), [DEFAULT_ACTIVE_COMMUNITY]);
    assert.deepEqual(parseRedditCommunities("   ,  , "), [DEFAULT_ACTIVE_COMMUNITY]);

    assert.ok(
      SUPPORTED_REDDIT_COMMUNITIES.length > 1,
      "this test is only meaningful while more than one community is supported",
    );
    assert.notDeepEqual(parseRedditCommunities(undefined), [...SUPPORTED_REDDIT_COMMUNITIES]);
  });

  it("keeps the supported catalog wider than the active list", () => {
    // Multi-community support was NOT removed. Supported ≠ active is the whole
    // correction: one is what the product knows, the other what it reads.
    for (const community of ["stocks", "options", "investing", "pennystocks"]) {
      assert.ok(
        SUPPORTED_REDDIT_COMMUNITIES.includes(community),
        `${community} must stay supported`,
      );
    }
  });
});

describe("the shipped configuration", () => {
  it("is wallstreetbets only", () => {
    assert.deepEqual([...ACTIVE_REDDIT_COMMUNITIES], ["wallstreetbets"]);
  });

  it("derives selection from the list rather than a second variable", () => {
    assert.equal(ALLOW_REDDIT_COMMUNITY_SELECTION, false);
    assert.equal(ALLOW_REDDIT_COMMUNITY_SELECTION, ACTIVE_REDDIT_COMMUNITIES.length > 1);
  });

  it("labels the active communities for the public endpoint", () => {
    assert.deepEqual(activeCommunityOptions(), [
      { id: "wallstreetbets", label: "r/wallstreetbets" },
    ]);
  });
});

describe("backend enforcement — a query string cannot widen scope", () => {
  it("ignores an inactive community entirely", () => {
    assert.deepEqual(resolveEffectiveRedditCommunities(["options"]), ["wallstreetbets"]);
    assert.deepEqual(effectiveCommunitiesFromQuery("options"), ["wallstreetbets"]);
  });

  it("ignores a whole list of inactive communities", () => {
    assert.deepEqual(effectiveCommunitiesFromQuery("options,stocks,investing"), [
      "wallstreetbets",
    ]);
  });

  it("keeps the active one when it is mixed in with inactive ones", () => {
    assert.deepEqual(effectiveCommunitiesFromQuery("options,wallstreetbets"), [
      "wallstreetbets",
    ]);
  });

  it("defaults to the active list when nothing is requested", () => {
    assert.deepEqual(resolveEffectiveRedditCommunities(undefined), ["wallstreetbets"]);
    assert.deepEqual(resolveEffectiveRedditCommunities([]), ["wallstreetbets"]);
    assert.deepEqual(effectiveCommunitiesFromQuery(null), ["wallstreetbets"]);
  });

  it("NEVER returns an empty list", () => {
    // An empty list reads as "every community" to the filter builders — the
    // precise inversion this function exists to prevent.
    for (const input of ["", "options", "banana", "  ,  ", "stocks,investing"]) {
      const result = effectiveCommunitiesFromQuery(input);
      assert.ok(result.length > 0, `"${input}" produced an empty scope`);
      for (const community of result) {
        assert.ok(isActiveCommunity(community), `${community} is not active`);
      }
    }
  });

  it("only ever returns active communities, for any input", () => {
    const inputs = ["options", "r/stocks", "WALLSTREETBETS", "nonsense", "options,nonsense"];
    for (const input of inputs) {
      for (const community of effectiveCommunitiesFromQuery(input)) {
        assert.ok(
          ACTIVE_REDDIT_COMMUNITIES.includes(community),
          `${input} leaked ${community}`,
        );
      }
    }
  });
});

describe("what happens when a second community is activated", () => {
  // Exercised through the pure parser, since the live list is read once at
  // module load. This is the future the design has to support without a code
  // change anywhere.
  it("accepts two supported communities and would enable selection", () => {
    const parsed = parseRedditCommunities("wallstreetbets,options");
    assert.deepEqual(parsed, ["wallstreetbets", "options"]);
    assert.equal(parsed.length > 1, true);
  });
});
