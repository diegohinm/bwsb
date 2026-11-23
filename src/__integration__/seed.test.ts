// FIRST: refuses unless TEST_DATABASE=true and the test project is configured.
import "./requireTestDatabase.js";

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { disconnectPrisma, prisma } from "../lib/prisma.js";

/**
 * What `prisma db seed` guarantees, checked right after CI ran it.
 *
 * Only the always-seeded tiers (reference data + default configuration) are
 * asserted. Demo data is opt-in (SEED_DEMO_DATA) and CI never asks for it, so
 * no test may expect it.
 *
 * prisma/seed.ts runs on import, so its lists cannot be imported here; these
 * are a stable subset of them. If the seed drops one, change it here too.
 */
const SEEDED_TICKERS = ["AAPL", "NVDA", "QQQ", "RDDT", "SPY"];
const DEFAULT_COMPETITION_SLUG = "yolo-arena-season-04";

after(async () => {
  await disconnectPrisma();
});

describe("seed reference data", () => {
  it("has the reference tickers, active", async () => {
    const rows = await prisma.tickers.findMany({
      where: { ticker: { in: SEEDED_TICKERS } },
      select: { ticker: true, isActive: true },
      orderBy: { ticker: "asc" },
    });
    assert.deepEqual(
      rows.map((r) => r.ticker),
      SEEDED_TICKERS,
    );
    for (const row of rows) assert.equal(row.isActive, true, `${row.ticker} must be active`);
  });

  it("has the default paper-trading season", async () => {
    const season = await prisma.competitions.findUnique({
      where: { slug: DEFAULT_COMPETITION_SLUG },
      select: { isActive: true, startingCash: true },
    });
    assert.ok(season, `competition ${DEFAULT_COMPETITION_SLUG} must exist`);
    assert.equal(season.isActive, true);
    assert.equal(season.startingCash?.toNumber(), 100_000);
  });
});
