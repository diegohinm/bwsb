import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeBySymbol, planSourceReconciliation, type ExistingRow } from "../reconcile.js";
import { SOURCE_IDS, type NormalizedTickerRecord } from "../types.js";
import { parseCboeIndexes } from "../sources/cboeIndexes.source.js";
import { parseNasdaqListed, MIN_EXPECTED_NASDAQ_RECORDS } from "../sources/nasdaqListed.source.js";
import { parseOtherListed, MIN_EXPECTED_OTHER_LISTED_RECORDS } from "../sources/otherListed.source.js";
import { isAmbiguousTicker } from "../../../config/tickers/ambiguousTickers.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

function pad(text: string, rows: number, make: (i: number) => string): string {
  const filler = Array.from({ length: rows }, (_, i) => make(i)).join("\n");
  return text.replace(/^File Creation Time.*$/m, `${filler}\nFile Creation Time: 0807202621:31||||||`);
}

const nasdaq = () =>
  parseNasdaqListed(
    pad(read("nasdaqlisted.sample.txt"), MIN_EXPECTED_NASDAQ_RECORDS, (i) =>
      `NPAD${i}|Padding Corp ${i} - Common Stock|Q|N|N|100|N|N`),
  ).records;

const other = () =>
  parseOtherListed(
    pad(read("otherlisted.sample.txt"), MIN_EXPECTED_OTHER_LISTED_RECORDS, (i) =>
      `OPAD${i}|Padding Corp ${i}|N|OPAD${i}|N|100|N|OPAD${i}`),
  ).records;

const cboe = () => parseCboeIndexes(read("cboe-indexes.sample.json")).records;

const record = (
  symbol: string,
  source: NormalizedTickerRecord["source"],
  securityType: NormalizedTickerRecord["securityType"],
): NormalizedTickerRecord => ({
  symbol,
  companyName: `${symbol} Inc.`,
  exchange: "X",
  securityType,
  source,
});

const rows = (...specs: [string, boolean | null, string | null][]): ExistingRow[] =>
  specs.map(([symbol, isActive, source]) => ({ symbol, isActive, source }));

// ── CROSS-SOURCE ────────────────────────────────────────────────────────────

describe("merging all three sources", () => {
  const merged = () => mergeBySymbol([cboe(), nasdaq(), other()]);

  it("produces one catalog containing every kind of instrument", () => {
    const map = new Map(merged().records.map((r) => [r.symbol, r]));
    for (const expected of ["SPY", "QQQ", "SPX", "NVDA", "VIX", "RUT"]) {
      assert.ok(map.has(expected), `${expected} must be in the merged catalog`);
    }
  });

  it("keeps each instrument's own classification", () => {
    const map = new Map(merged().records.map((r) => [r.symbol, r]));
    assert.equal(map.get("SPY")?.securityType, "ETF");
    assert.equal(map.get("SPY")?.exchange, "NYSE_ARCA");
    assert.equal(map.get("QQQ")?.securityType, "ETF");
    assert.equal(map.get("QQQ")?.exchange, "NASDAQ");
    assert.equal(map.get("SPX")?.securityType, "INDEX");
    assert.equal(map.get("SPX")?.exchange, "CBOE");
    assert.equal(map.get("NVDA")?.securityType, "STOCK");
    assert.equal(map.get("NVDA")?.exchange, "NASDAQ");
  });

  it("emits no duplicate symbols", () => {
    const symbols = merged().records.map((r) => r.symbol);
    assert.equal(symbols.length, new Set(symbols).size);
  });

  it("keeps SPX traceable to the index directory", () => {
    const spx = merged().records.find((r) => r.symbol === "SPX");
    assert.equal(spx?.source, SOURCE_IDS.cboeIndexes);
  });
});

describe("source precedence", () => {
  it("keeps an index-only symbol as an INDEX", () => {
    // SPX appears in neither listing directory, so nothing competes with it.
    const merged = mergeBySymbol([nasdaq(), other(), cboe()]);
    const spx = merged.records.find((r) => r.symbol === "SPX");
    assert.equal(spx?.securityType, "INDEX");
    assert.equal(spx?.source, SOURCE_IDS.cboeIndexes);
  });

  it("lets a real listed security beat a benchmark index of the same name", () => {
    // Measured on live data: Cboe publishes "S&P 500 Buffer Protect Index"
    // under SPRO, which is also Spero Therapeutics on Nasdaq. Someone writing
    // SPRO means the biotech, not an untradable structured-product benchmark.
    const merged = mergeBySymbol([
      [record("SPRO", SOURCE_IDS.cboeIndexes, "INDEX")],
      [record("SPRO", SOURCE_IDS.nasdaqListed, "STOCK")],
    ]);
    const spro = merged.records.find((r) => r.symbol === "SPRO");
    assert.equal(spro?.securityType, "STOCK");
    assert.equal(spro?.source, SOURCE_IDS.nasdaqListed);
  });

  it("resolves the same way regardless of input order", () => {
    const a = mergeBySymbol([
      [record("SPRO", SOURCE_IDS.cboeIndexes, "INDEX")],
      [record("SPRO", SOURCE_IDS.nasdaqListed, "STOCK")],
    ]);
    const b = mergeBySymbol([
      [record("SPRO", SOURCE_IDS.nasdaqListed, "STOCK")],
      [record("SPRO", SOURCE_IDS.cboeIndexes, "INDEX")],
    ]);
    assert.equal(a.records[0]?.source, b.records[0]?.source);
    assert.equal(a.records[0]?.securityType, "STOCK");
  });

  it("reports the collision instead of resolving it silently", () => {
    const merged = mergeBySymbol([
      [record("SPRO", SOURCE_IDS.cboeIndexes, "INDEX")],
      [record("SPRO", SOURCE_IDS.nasdaqListed, "STOCK")],
    ]);
    assert.equal(merged.collisions.length, 1);
    assert.deepEqual(merged.collisions[0], {
      symbol: "SPRO",
      winner: SOURCE_IDS.nasdaqListed,
      loser: SOURCE_IDS.cboeIndexes,
    });
  });

  it("reports nothing when the sources are disjoint, as they should be", () => {
    assert.deepEqual(mergeBySymbol([nasdaq(), other(), cboe()]).collisions, []);
  });
});

// ── PER-SOURCE RECONCILIATION ───────────────────────────────────────────────

describe("a source only governs its own universe", () => {
  const catalog = rows(
    ["QQQ", true, SOURCE_IDS.nasdaqListed],
    ["NVDA", true, SOURCE_IDS.nasdaqListed],
    ["SPY", true, SOURCE_IDS.otherListed],
    ["SPX", true, SOURCE_IDS.cboeIndexes],
    ["LEGACY", true, null],
  );

  it("does not deactivate another source's symbols", () => {
    // The failure this prevents: a healthy NASDAQ refresh retiring SPX and SPY
    // simply because its own directory does not mention them.
    const plan = planSourceReconciliation(catalog, ["QQQ", "NVDA"], SOURCE_IDS.nasdaqListed);
    assert.deepEqual(plan.deactivated, []);
  });

  it("deactivates one of its own that has gone", () => {
    const plan = planSourceReconciliation(catalog, ["QQQ"], SOURCE_IDS.nasdaqListed);
    assert.deepEqual(plan.deactivated, ["NVDA"]);
  });

  it("never touches a row owned by no importer", () => {
    const plan = planSourceReconciliation(catalog, ["QQQ", "NVDA"], SOURCE_IDS.nasdaqListed);
    assert.ok(!plan.deactivated.includes("LEGACY"));
  });

  it("adopts a symbol that arrives from a different source", () => {
    const plan = planSourceReconciliation(catalog, ["SPY"], SOURCE_IDS.nasdaqListed);
    assert.deepEqual(plan.updated, ["SPY"]);
    assert.deepEqual(plan.created, []);
  });

  it("reactivates one of its own that has returned", () => {
    const withDelisted = rows(["OLD", false, SOURCE_IDS.otherListed]);
    const plan = planSourceReconciliation(withDelisted, ["OLD"], SOURCE_IDS.otherListed);
    assert.deepEqual(plan.reactivated, ["OLD"]);
  });

  it("never deletes — the plan has no delete channel", () => {
    const plan = planSourceReconciliation(catalog, ["QQQ"], SOURCE_IDS.nasdaqListed);
    assert.ok(!("deleted" in plan));
  });
});

describe("idempotency", () => {
  it("changes nothing structural on a second identical run", () => {
    const first = planSourceReconciliation([], ["QQQ", "NVDA"], SOURCE_IDS.nasdaqListed);
    assert.equal(first.created.length, 2);

    const second = planSourceReconciliation(
      rows(["QQQ", true, SOURCE_IDS.nasdaqListed], ["NVDA", true, SOURCE_IDS.nasdaqListed]),
      ["QQQ", "NVDA"],
      SOURCE_IDS.nasdaqListed,
    );
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.reactivated, []);
    assert.deepEqual(second.deactivated, []);
    assert.equal(second.updated.length, 2);
  });

  it("collapses a repeated symbol so a batch cannot fail on it", () => {
    const plan = planSourceReconciliation([], ["QQQ", "QQQ"], SOURCE_IDS.nasdaqListed);
    assert.deepEqual(plan.created, ["QQQ"]);
  });
});

/**
 * PARTIAL FAILURE — the scenario the task calls out by name.
 *
 * NASDAQ and Other Listed succeed, Cboe returns 500. The two that worked apply
 * normally; SPX must survive untouched.
 */
describe("partial source failure", () => {
  const catalog = rows(
    ["QQQ", true, SOURCE_IDS.nasdaqListed],
    ["SPY", true, SOURCE_IDS.otherListed],
    ["SPX", true, SOURCE_IDS.cboeIndexes],
  );

  it("leaves SPX active when only Cboe fails", () => {
    // A failed source never reaches planSourceReconciliation at all, so the
    // only plans that exist are the two that succeeded.
    const nasdaqPlan = planSourceReconciliation(catalog, ["QQQ"], SOURCE_IDS.nasdaqListed);
    const otherPlan = planSourceReconciliation(catalog, ["SPY"], SOURCE_IDS.otherListed);

    const deactivated = [...nasdaqPlan.deactivated, ...otherPlan.deactivated];
    assert.deepEqual(deactivated, [], "no source may retire another's rows");
    assert.ok(catalog.find((r) => r.symbol === "SPX")?.isActive === true);
  });

  it("still refreshes the sources that worked", () => {
    assert.deepEqual(
      planSourceReconciliation(catalog, ["QQQ"], SOURCE_IDS.nasdaqListed).updated,
      ["QQQ"],
    );
    assert.deepEqual(
      planSourceReconciliation(catalog, ["SPY"], SOURCE_IDS.otherListed).updated,
      ["SPY"],
    );
  });
});

/**
 * GLOBAL FAILURE — no source produced a validated dataset, so no plan was ever
 * built and nothing can have been written.
 */
describe("total source failure", () => {
  it("produces no plans at all", () => {
    const payloads = ["", "<html>500</html>", "{}"];
    for (const payload of payloads) {
      assert.throws(() => parseNasdaqListed(payload));
      assert.throws(() => parseOtherListed(payload));
      assert.throws(() => parseCboeIndexes(payload));
    }
  });
});

// ── AMBIGUITY IS YOLOPULSE DATA ─────────────────────────────────────────────

describe("ambiguity metadata", () => {
  it("flags the configured symbols and nothing else", () => {
    assert.equal(isAmbiguousTicker("AI"), true);
    assert.equal(isAmbiguousTicker("ON"), true);
    assert.equal(isAmbiguousTicker("IT"), true);
    for (const plain of ["SPY", "QQQ", "SPX", "NVDA", "VIX", "RUT"]) {
      assert.equal(isAmbiguousTicker(plain), false, `${plain} is not ambiguous`);
    }
  });

  it("is derived from configuration, never from any source payload", () => {
    // Every adapter's record type has no ambiguity field at all — it is applied
    // at upsert time from the config, so a directory cannot overwrite it.
    for (const r of [...nasdaq(), ...other(), ...cboe()]) {
      assert.ok(!("isAmbiguous" in r), "no source may supply ambiguity");
    }
  });

  it("applies to a symbol whichever source supplies it", () => {
    // ON is Nasdaq-listed, AI is NYSE-listed — the flag follows the symbol.
    assert.ok(nasdaq().some((r) => r.symbol === "ON"));
    assert.equal(isAmbiguousTicker("ON"), true);
    assert.equal(isAmbiguousTicker("AI"), true);
  });
});
