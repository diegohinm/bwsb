import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const worker = readFileSync(resolve(SRC, "worker.ts"), "utf8");

/**
 * THE SCHEDULER IS REGISTERED EXACTLY ONCE.
 *
 * A duplicated `startJobLoop` is the cheapest possible way to double a bill and
 * the hardest to notice: both loops work, both produce sensible logs, both
 * checkpoint correctly, and the only symptom is that Mindcase is paid twice.
 * The in-process overlap guard does not help — two separate loop closures each
 * keep their own `running` flag.
 *
 * Source-level because there is nothing to observe at runtime: by the time the
 * duplicate is visible in an invoice it has been running for a month.
 */

function countRegistrations(name: string): number {
  // `startJobLoop({ name: "x"` — the literal the loop is registered under.
  const pattern = new RegExp(`name:\\s*"${name}"`, "g");
  return (worker.match(pattern) ?? []).length;
}

describe("worker job registration", () => {
  for (const job of ["syncRedditPosts", "syncRedditComments", "refreshSocialPulse"]) {
    it(`registers ${job} exactly once`, () => {
      assert.equal(
        countRegistrations(job),
        1,
        `${job} is registered ${countRegistrations(job)} times — every extra ` +
          `registration multiplies provider spend by one.`,
      );
    });
  }

  it("schedules posts on the configured interval, not a hardcoded one", () => {
    assert.match(worker, /intervalSeconds:\s*env\.REDDIT_POSTS_INTERVAL_MINUTES\s*\*\s*60/);
  });

  it("no longer registers the old multi-subreddit Mindcase sweep as a fetcher", () => {
    // refreshSocialPulse still exists and still runs — it just aggregates stored
    // rows now. If it ever regains a provider call, the separation test for its
    // module will be the one that fails; this pins the scheduling side.
    const pulse = readFileSync(resolve(SRC, "jobs/refreshSocialPulse.job.ts"), "utf8");
    assert.ok(
      !/getSocialDataProvider|fetchItems/.test(pulse),
      "refreshSocialPulse must not fetch — that is what the sync jobs are for",
    );
  });
});

describe("what the startup banner must disclose", () => {
  it("prints the ingestion configuration before scheduling anything", () => {
    assert.ok(
      worker.includes("describeRedditIngestion()"),
      "the boot log must state which communities and cadences will be paid for",
    );
  });
});
