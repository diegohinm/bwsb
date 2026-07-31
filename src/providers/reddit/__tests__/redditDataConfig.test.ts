import "./helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRedditDataConfig,
  RedditDataConfigError,
} from "../../../config/redditDataConfig.js";

/**
 * Environment validation.
 *
 * The point of these tests is that a CONTRADICTORY configuration fails loudly
 * at startup rather than silently ingesting from nothing.
 */
describe("redditDataConfig", () => {
  it("parses a full valid hybrid configuration", () => {
    const config = buildRedditDataConfig({
      REDDIT_DATA_MODE: "hybrid",
      REDDIT_PRIMARY_PROVIDER: "arctic_shift",
      REDDIT_FALLBACK_PROVIDER: "mindcase",
      REDDIT_ENABLE_MINDCASE: "true",
      REDDIT_ENABLE_ARCTIC_SHIFT: "true",
      REDDIT_PROVIDER_TIMEOUT_MS: "30000",
      REDDIT_PROVIDER_MAX_RETRIES: "3",
      REDDIT_PROVIDER_RETRY_DELAY_MS: "5000",
      REDDIT_DEDUPLICATE_RESULTS: "true",
      REDDIT_STORE_SOURCE_METADATA: "true",
      MINDCASE_API_KEY: "key",
      MINDCASE_BASE_URL: "https://api.mindcase.co",
      ARCTIC_SHIFT_BASE_URL: "https://arctic-shift.photon-reddit.com",
      ARCTIC_SHIFT_REQUEST_DELAY_MS: "1000",
    });

    assert.equal(config.mode, "hybrid");
    assert.equal(config.timeoutMs, 30_000);
    assert.equal(config.maxRetries, 3);
    assert.equal(config.retryDelayMs, 5_000);
    assert.equal(config.deduplicateResults, true);
    assert.equal(config.storeSourceMetadata, true);
    // The preferred provider leads, so it wins `primarySource` on merges.
    assert.deepEqual(config.activeProviders, ["arctic_shift", "mindcase"]);
  });

  it("defaults to arctic_shift, the provider that needs no API key", () => {
    const config = buildRedditDataConfig({});
    assert.equal(config.mode, "arctic_shift");
    assert.deepEqual(config.activeProviders, ["arctic_shift"]);
  });

  it("rejects an unknown mode", () => {
    assert.throws(
      () => buildRedditDataConfig({ REDDIT_DATA_MODE: "pushshift" }),
      RedditDataConfigError,
    );
  });

  it("rejects mode=mindcase while Mindcase is disabled", () => {
    assert.throws(
      () =>
        buildRedditDataConfig({
          REDDIT_DATA_MODE: "mindcase",
          REDDIT_ENABLE_MINDCASE: "false",
        }),
      /REDDIT_DATA_MODE=mindcase requires REDDIT_ENABLE_MINDCASE=true/,
    );
  });

  it("rejects mode=arctic_shift while Arctic Shift is disabled", () => {
    assert.throws(
      () =>
        buildRedditDataConfig({
          REDDIT_DATA_MODE: "arctic_shift",
          REDDIT_ENABLE_ARCTIC_SHIFT: "false",
        }),
      /REDDIT_ENABLE_ARCTIC_SHIFT=true/,
    );
  });

  it("rejects a fallback pair that is the same provider twice", () => {
    assert.throws(
      () =>
        buildRedditDataConfig({
          REDDIT_DATA_MODE: "fallback",
          REDDIT_PRIMARY_PROVIDER: "arctic_shift",
          REDDIT_FALLBACK_PROVIDER: "arctic_shift",
        }),
      /must be different/,
    );
  });

  it("rejects a fallback whose secondary is disabled", () => {
    assert.throws(
      () =>
        buildRedditDataConfig({
          REDDIT_DATA_MODE: "fallback",
          REDDIT_PRIMARY_PROVIDER: "arctic_shift",
          REDDIT_FALLBACK_PROVIDER: "mindcase",
          REDDIT_ENABLE_MINDCASE: "false",
        }),
      /REDDIT_FALLBACK_PROVIDER=mindcase is disabled/,
    );
  });

  it("rejects hybrid with nothing enabled", () => {
    assert.throws(
      () =>
        buildRedditDataConfig({
          REDDIT_DATA_MODE: "hybrid",
          REDDIT_ENABLE_MINDCASE: "false",
          REDDIT_ENABLE_ARCTIC_SHIFT: "false",
        }),
      /at least one/,
    );
  });

  it("does not require MINDCASE_API_KEY when Mindcase is disabled", () => {
    const config = buildRedditDataConfig({
      REDDIT_DATA_MODE: "arctic_shift",
      REDDIT_ENABLE_MINDCASE: "false",
    });
    assert.equal(config.mindcase.apiKey, undefined);
    assert.deepEqual(config.activeProviders, ["arctic_shift"]);
  });

  it("converts boolean strings and rejects nonsense", () => {
    assert.equal(
      buildRedditDataConfig({ REDDIT_DEDUPLICATE_RESULTS: "false" })
        .deduplicateResults,
      false,
    );
    assert.equal(
      buildRedditDataConfig({ REDDIT_DEDUPLICATE_RESULTS: "0" })
        .deduplicateResults,
      false,
    );
    // Unset means "on" for the dedup/metadata flags.
    assert.equal(buildRedditDataConfig({}).deduplicateResults, true);
    assert.throws(
      () => buildRedditDataConfig({ REDDIT_ENABLE_MINDCASE: "tru" }),
      /must be true or false/,
    );
  });

  it("converts numbers and rejects unparseable or out-of-range values", () => {
    assert.equal(
      buildRedditDataConfig({ REDDIT_PROVIDER_TIMEOUT_MS: "12000" }).timeoutMs,
      12_000,
    );
    assert.throws(
      () => buildRedditDataConfig({ REDDIT_PROVIDER_TIMEOUT_MS: "soon" }),
      /must be an integer/,
    );
    assert.throws(
      () => buildRedditDataConfig({ REDDIT_PROVIDER_MAX_RETRIES: "99" }),
      /must be between 0 and 10/,
    );
  });

  it("rejects a non-URL base URL", () => {
    assert.throws(
      () => buildRedditDataConfig({ ARCTIC_SHIFT_BASE_URL: "arctic-shift" }),
      /must be a valid absolute URL/,
    );
  });

  it("honours the legacy MINDCASE_MAX_POLLS name", () => {
    assert.equal(
      buildRedditDataConfig({ MINDCASE_MAX_POLLS: "7" }).mindcase.maxPollAttempts,
      7,
    );
    // The new name wins when both are present.
    assert.equal(
      buildRedditDataConfig({
        MINDCASE_MAX_POLLS: "7",
        MINDCASE_MAX_POLL_ATTEMPTS: "12",
      }).mindcase.maxPollAttempts,
      12,
    );
  });
});
