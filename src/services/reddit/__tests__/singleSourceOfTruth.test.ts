import "../../../providers/reddit/__tests__/helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE BUG THIS FILE EXISTS TO PREVENT FROM COMING BACK.
 *
 * Reddit ingestion used to have TWO provider selectors. `REDDIT_DATA_MODE`
 * chose an upstream for one pipeline; the jobs that actually ran on a schedule
 * resolved theirs from `SOCIAL_DATA_PROVIDER` through the social-data factory.
 * So the free archive could be configured as the Reddit source while every
 * scheduled run still went to the metered client — and BOTH settings looked
 * correct, because each really was authoritative, for a different pipeline.
 *
 * That class of bug is invisible in a unit test of either half. It is only
 * visible in the import graph, which is what these tests read. A source scan is
 * a blunt instrument, but the thing being protected is a recurring bill, and
 * the failure mode is silence.
 */

const SRC = join(process.cwd(), "src");

type SourceFile = { path: string; text: string; code: string };

/**
 * The file with its comments removed.
 *
 * These guards are about what the CODE reaches, not about what the prose
 * mentions. Scanning raw text would make a file fail for explaining the very
 * bug it was written to prevent — which would push the explanation out of the
 * codebase, and the explanation is the most valuable part of it.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function collect(dir: string, acc: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      collect(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(full, "utf8");
    acc.push({
      path: full.slice(SRC.length + 1).replace(/\\/g, "/"),
      text,
      code: stripComments(text),
    });
  }
  return acc;
}

const files = collect(SRC);
const byPath = new Map(files.map((f) => [f.path, f]));

describe("one selector for Reddit ingestion", () => {
  it("keeps the social-data factory out of the ingestion path entirely", () => {
    // THE ORIGINAL BUG, asserted directly. `getSocialDataProvider` is keyed on
    // SOCIAL_DATA_PROVIDER and also serves the READ paths, so any ingestion
    // code that calls it reintroduces a second, independent answer to "which
    // upstream collects Reddit data".
    const offenders = files
      .filter((f) => f.path.startsWith("jobs/") || f.path.startsWith("services/reddit/"))
      .filter((f) => /getSocialDataProvider/.test(f.code))
      .map((f) => f.path);

    assert.deepEqual(
      offenders,
      [],
      "ingestion must resolve its upstream through services/reddit/redditSourceRouter.ts, " +
        "never through the SOCIAL_DATA_PROVIDER factory",
    );
  });

  it("reaches the metered client through exactly one module", () => {
    // "Are we spending money" should be answerable by looking at who imports
    // one file, rather than by tracing an env var through a shared factory.
    const importers = files
      .filter((f) => f.path !== "services/reddit/meteredRedditFetcher.ts")
      .filter((f) => !f.path.startsWith("services/social/"))
      .filter((f) => /mindcaseSocialData\.provider\.js/.test(f.code))
      .map((f) => f.path);

    assert.deepEqual(
      importers,
      [],
      "outside services/social, the metered client must be reached only via " +
        "services/reddit/meteredRedditFetcher.ts",
    );
  });

  it("routes the metered fetcher through the router and nothing else", () => {
    const importers = files
      .filter((f) => /meteredRedditFetcher\.js/.test(f.code))
      .map((f) => f.path)
      .sort();

    // The two ingestion jobs hand it to the router as an injected dependency;
    // the router is what decides whether it is ever called.
    assert.deepEqual(importers, [
      "jobs/syncRedditComments.job.ts",
      "jobs/syncRedditPosts.job.ts",
    ]);
  });
});

describe("the router cannot secretly reach the read-path factory", () => {
  it("has no import path from the router to the social-data factory", () => {
    // A transitive walk, not a grep: the failure being guarded against is an
    // indirect import three hops away that nobody notices.
    const seen = new Set<string>();
    const stack = ["services/reddit/redditSourceRouter.ts"];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const file = byPath.get(current);
      if (!file) continue;

      for (const match of file.code.matchAll(/from\s+"([^"]+\.js)"/g)) {
        const spec = match[1];
        if (!spec || !spec.startsWith(".")) continue;
        const dir = current.split("/").slice(0, -1);
        for (const part of spec.replace(/\.js$/, "").split("/")) {
          if (part === ".") continue;
          if (part === "..") dir.pop();
          else dir.push(part);
        }
        stack.push(`${dir.join("/")}.ts`);
      }
    }

    assert.ok(
      !seen.has("services/social/socialDataProvider.factory.ts"),
      "the ingestion router must not be able to reach the SOCIAL_DATA_PROVIDER factory",
    );
  });
});

describe("the scheduler registers each ingestion loop exactly once", () => {
  it("does not double-register, which would double the request rate", () => {
    const worker = byPath.get("worker.ts");
    assert.ok(worker, "worker.ts must exist");
    const code: string = worker.code;
    for (const job of ["syncRedditPosts", "syncRedditComments"]) {
      const count: number = code.split(`name: "${job}"`).length - 1;
      assert.equal(count, 1, `${job} must be registered exactly once, found ${count}`);
    }
  });

  it("still drives the posts cadence from the configured interval", () => {
    const worker = byPath.get("worker.ts");
    assert.match(
      worker?.text ?? "",
      /intervalSeconds:\s*env\.REDDIT_POSTS_INTERVAL_MINUTES\s*\*\s*60/,
      "the posts loop must read its cadence from REDDIT_POSTS_INTERVAL_MINUTES",
    );
  });
});

describe("the free source carries the same community guard as the metered one", () => {
  it("asserts community scope before building any archive request", () => {
    // Free does not mean unscoped: without this, the restriction on which
    // communities may be ingested could be bypassed through the cheap door.
    const adapter = byPath.get("services/social/providers/arcticShiftSocialData.provider.ts");
    assert.ok(adapter, "the archive adapter must exist");
    // `.code`, not `.text`: a comment that merely NAMES the guard must not be
    // able to satisfy a test that exists to prove the guard is actually called.
    assert.match(
      adapter.code,
      /assertCommunityIsActive\(/,
      "the archive adapter can reach an upstream without asserting community scope",
    );
  });
});
