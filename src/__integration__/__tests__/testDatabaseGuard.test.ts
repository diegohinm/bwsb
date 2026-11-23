import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { supabaseProjectRef, testDatabaseRefusals } from "../testDatabaseGuard.js";

/**
 * The integration suite's only protection against writing to the wrong
 * database. A unit test — no database, no network — so a regression in a rule
 * fails `npm test` long before anything runs against Supabase.
 *
 * Every value below is fake. "abcdefghijklmnopqrst" stands in for the test
 * project's ref, "zyxwvutsrqponmlkjihg" for some other project.
 */

const TEST_REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";
const PASSWORD = "s3cret-Passw0rd";
const SERVICE_KEY = "fake-service-role-key-value";

const valid = {
  TEST_DATABASE: "true",
  NODE_ENV: "test",
  DATABASE_URL: `postgresql://postgres.${TEST_REF}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
  SUPABASE_URL: `https://${TEST_REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

describe("the integration suite proceeds only on explicit opt-in", () => {
  it("accepts a complete test configuration", () => {
    assert.deepEqual(testDatabaseRefusals(valid), []);
  });

  it("refuses without TEST_DATABASE=true — any other spelling included", () => {
    for (const value of [undefined, "", "false", "1", "TRUE", "yes", " true"]) {
      const refusals = testDatabaseRefusals({ ...valid, TEST_DATABASE: value });
      assert.ok(
        refusals.some((r) => r.includes("TEST_DATABASE=true")),
        `TEST_DATABASE=${JSON.stringify(value)} must be refused`,
      );
    }
  });

  it("refuses NODE_ENV=production even when TEST_DATABASE=true", () => {
    assert.ok(testDatabaseRefusals({ ...valid, NODE_ENV: "production" }).includes("NODE_ENV=production"));
  });
});

describe("credentials must come from the environment", () => {
  it("names every missing or blank connection variable", () => {
    const [refusal] = testDatabaseRefusals({
      ...valid,
      DATABASE_URL: undefined,
      SUPABASE_URL: "   ",
      SUPABASE_SERVICE_ROLE_KEY: "",
    });
    assert.match(refusal, /DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("the database must belong to the Supabase project in SUPABASE_URL", () => {
  it("accepts the session/transaction pooler form (ref in the user name)", () => {
    assert.deepEqual(testDatabaseRefusals(valid), []);
  });

  it("accepts the direct-connection form (ref in the host)", () => {
    const direct = `postgresql://postgres:${PASSWORD}@db.${TEST_REF}.supabase.co:5432/postgres`;
    assert.deepEqual(testDatabaseRefusals({ ...valid, DATABASE_URL: direct }), []);
  });

  it("refuses a database from another project", () => {
    const other = valid.DATABASE_URL.replace(TEST_REF, OTHER_REF);
    const refusals = testDatabaseRefusals({ ...valid, DATABASE_URL: other });
    assert.ok(refusals.some((r) => /does not belong/.test(r)));
  });

  it("never counts the password as naming the project", () => {
    const sneaky = `postgresql://postgres.${OTHER_REF}:${TEST_REF}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
    assert.ok(testDatabaseRefusals({ ...valid, DATABASE_URL: sneaky }).length > 0);
  });

  it("skips the comparison for a custom API domain it cannot read a ref from", () => {
    assert.equal(supabaseProjectRef("https://api.example.com"), null);
    assert.deepEqual(testDatabaseRefusals({ ...valid, SUPABASE_URL: "https://api.example.com" }), []);
  });

  it("reads the ref from a supabase.co URL, with or without a trailing slash", () => {
    assert.equal(supabaseProjectRef(`https://${TEST_REF}.supabase.co`), TEST_REF);
    assert.equal(supabaseProjectRef(`https://${TEST_REF}.supabase.co/`), TEST_REF);
    assert.equal(supabaseProjectRef("not a url"), null);
  });
});

describe("refusals never carry a secret", () => {
  it("names variables, not values", () => {
    const everythingWrong = {
      TEST_DATABASE: "false",
      NODE_ENV: "production",
      DATABASE_URL: valid.DATABASE_URL.replace(TEST_REF, OTHER_REF),
      SUPABASE_URL: valid.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    };
    const text = testDatabaseRefusals(everythingWrong).join("\n");
    for (const secret of [PASSWORD, SERVICE_KEY, TEST_REF, OTHER_REF, "pooler.supabase.com"]) {
      assert.ok(!text.includes(secret), `a refusal leaked ${secret}`);
    }
  });
});
