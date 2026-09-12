import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NO SECOND PLACE TO CONFIGURE COMMUNITIES.
 *
 * The bug this guards against is not a logic error — every copy of the list was
 * individually correct when written. It is DRIFT: three places held the same
 * fact (the backend's `REDDIT_SUBREDDITS`, the worker's ingestion list, the
 * frontend's `DISCUSSION_COMMUNITY_CONFIG`), they were edited at different
 * times, and the system ended up showing r/wallstreetbets while paying a
 * metered provider for r/options.
 *
 * A source scan, because the failure is invisible at runtime: a reintroduced
 * list works perfectly until the day it disagrees.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      sourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((f) => ({
  path: relative(SRC, f).replace(/\\/g, "/"),
  text: readFileSync(f, "utf8"),
}));

/** The files entitled to know the catalog exists. */
const CATALOG_OWNERS = new Set([
  "config/redditCommunities.ts",
  "services/social/subreddits.ts",
]);

describe("one environment variable, in one service", () => {
  it("reads REDDIT_ACTIVE_COMMUNITIES in exactly one module", () => {
    // Actual READS, not mentions: several modules name the variable in a
    // comment explaining where their scope comes from, which is the documented
    // arrangement rather than a violation of it.
    const readers = files
      .filter((f) => /process\.env\.REDDIT_ACTIVE_COMMUNITIES/.test(f.text))
      .filter((f) => !f.path.includes("__tests__"))
      .map((f) => f.path);

    assert.deepEqual(
      readers,
      ["config/redditCommunities.ts"],
      "the active-community variable must be parsed in one place only",
    );
  });

  it("has no worker-side community variable", () => {
    // The worker asks the backend. A variable of its own would be a second
    // truth, and the two could only agree by luck.
    const offenders = files
      .filter((f) => !f.path.includes("__tests__"))
      .filter((f) => /REDDIT_INGESTION_COMMUNITIES|WORKER_REDDIT_COMMUNITIES/.test(f.text))
      .map((f) => f.path);

    assert.deepEqual(offenders, [], "the worker must take its scope from the backend");
  });
});

describe("no parallel hardcoded community lists", () => {
  it("names the metered communities together in one place only", () => {
    // An array literal mentioning several investing subreddits is the shape of
    // the bug: a list somebody will edit instead of the env var.
    const suspicious = files
      .filter((f) => !CATALOG_OWNERS.has(f.path) && !f.path.includes("__tests__"))
      .filter((f) => {
        // Anchored on "wallstreetbets": finance prose legitimately contains the
        // words "options" and "stocks" — tickerExtraction's stopword list is
        // full of them — but only a COMMUNITY list names r/wallstreetbets
        // alongside them.
        const quoted = (c: string) => new RegExp(`["'\`]r?/?${c}["'\`]`, "i").test(f.text);
        if (!quoted("wallstreetbets")) return false;
        return ["options", "stocks", "investing", "pennystocks"].filter(quoted).length >= 1;
      })
      .map((f) => f.path);

    assert.deepEqual(
      suspicious,
      [],
      "these files hold their own multi-community list; derive it from " +
        "config/redditCommunities.ts instead",
    );
  });
});

describe("EVERY Mindcase client carries the guard", () => {
  it("guards both clients in the repo, including the dormant one", () => {
    // There are TWO Mindcase clients: the social provider (live today) and the
    // Reddit-provider-layer one, which is only constructed when
    // REDDIT_DATA_MODE names Mindcase. The dormant one is the dangerous one —
    // it is easy to forget and wakes up one deploy later still pointing at
    // whatever subreddit list it was written against.
    for (const path of [
      "services/social/providers/mindcaseSocialData.provider.ts",
      "providers/reddit/MindcaseProvider.ts",
    ]) {
      const client = files.find((f) => f.path === path);
      assert.ok(client, `${path} must exist`);
      assert.ok(
        /assertCommunityIsActive\(/.test(client.text),
        `${path} can reach Mindcase without asserting community scope`,
      );
    }
  });
});

describe("the Mindcase client cannot be reached without the guard", () => {
  it("asserts community scope before building a Reddit URL", () => {
    const provider = files.find(
      (f) => f.path === "services/social/providers/mindcaseSocialData.provider.ts",
    );
    assert.ok(provider, "the Mindcase social provider must exist");

    // Both agent entry points. The guard lives INSIDE the client precisely so a
    // buggy caller cannot skip it.
    const guards = provider.text.match(/assertCommunityIsActive\(/g) ?? [];
    assert.ok(
      guards.length >= 2,
      `expected a scope assertion on both the posts and comments paths, found ${guards.length}`,
    );
  });

  it("has no local fallback list when a caller names no community", () => {
    const provider = files.find(
      (f) => f.path === "services/social/providers/mindcaseSocialData.provider.ts",
    );
    assert.ok(provider);
    // The CODE, not the comment explaining why the fallback was removed.
    const code = provider.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(
      !/redditConfig\.subreddits/.test(code),
      "an omitted community list must not fall back to the tracked catalog — " +
        "that is how r/options was bought",
    );
  });
});
