// FIRST: refuses unless TEST_DATABASE=true and the test project is configured.
import "./requireTestDatabase.js";

import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Prisma } from "@prisma/client";

import { disconnectPrisma, prisma } from "../lib/prisma.js";
import { readArenaSeason } from "../services/arena/arenaSeason.service.js";
import { getAuthUserById } from "../services/auth/session.service.js";
import { CI_USER_001, createFixtureUser, removeFixtureUser } from "./fixtures.js";

/**
 * The migrated Supabase test database, exercised through the app's own code.
 *
 * Prerequisite: scripts/setup-test-db.sh (migrate deploy + seed) has run.
 * Nothing here depends on rows the suite did not write itself.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../prisma/migrations/", import.meta.url));

after(async () => {
  await disconnectPrisma();
});

describe("schema", () => {
  it("has every migration in prisma/migrations applied, and none left half-done", async () => {
    const local = readdirSync(MIGRATIONS_DIR)
      .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
      .sort();
    assert.ok(local.length > 0, "no migrations found — wrong working directory?");

    const rows = await prisma.$queryRaw<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;

    const applied = new Set(
      rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null).map((r) => r.migration_name),
    );
    assert.deepEqual(
      local.filter((name) => !applied.has(name)),
      [],
      "every local migration must be applied by `prisma migrate deploy`",
    );

    // Started and never finished: Prisma refuses to deploy past it, and the
    // schema is in an unknown state. (A rolled-back attempt is fine.)
    const unfinished = rows
      .filter((r) => r.finished_at === null && r.rolled_back_at === null)
      .map((r) => r.migration_name);
    assert.deepEqual(unfinished, [], "a migration is stuck — resolve it before trusting this database");
  });

  it("runs the Arena season's raw SQL against the real bet tables", async () => {
    // Raw SQL is where schema drift hides: Prisma's types cannot see it. The
    // counts depend on whatever the project holds, so only their shape is
    // asserted — the point is that the columns the query names exist.
    const view = await readArenaSeason(new Date());

    assert.equal(view.meta.source, "database");
    for (const [contest, counts] of Object.entries(view.contests)) {
      for (const [field, value] of Object.entries(counts)) {
        assert.ok(Number.isInteger(value) && value >= 0, `${contest}.${field} must be a non-negative count`);
      }
    }
  });
});

describe("a user the suite creates, read back through the session service", () => {
  before(async () => {
    await removeFixtureUser(CI_USER_001); // a leftover from a crashed run — ours, by exact address
  });

  after(async () => {
    await removeFixtureUser(CI_USER_001);
  });

  it("round-trips through getAuthUserById, the read path every authenticated request takes", async () => {
    const { id } = await createFixtureUser(CI_USER_001);
    assert.equal(id, CI_USER_001.id);

    const user = await getAuthUserById(CI_USER_001.id);
    assert.ok(user, "the fixture user must be readable");
    assert.equal(user.id, CI_USER_001.id);
    assert.equal(user.email, CI_USER_001.email);
    assert.equal(user.displayName, CI_USER_001.displayName);
    assert.equal(user.emailVerified, false);
    assert.equal(user.emailVerifiedAt, null);
    assert.equal(user.reddit, null);
  });

  it("enforces the unique email index the migrations create", async () => {
    await assert.rejects(
      createFixtureUser({ ...CI_USER_001, id: "c1000000-0000-4000-8000-000000000099" }),
      (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002",
    );
  });

  it("returns null — not someone else — for an id that does not exist", async () => {
    assert.equal(await getAuthUserById("c1000000-0000-4000-8000-0000000000ff"), null);
  });
});
