import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseNasdaqListed, MIN_EXPECTED_NASDAQ_RECORDS } from "../sources/nasdaqListed.source.js";
import {
  parseOtherListed,
  MIN_EXPECTED_OTHER_LISTED_RECORDS,
  labelForExchangeCode,
} from "../sources/otherListed.source.js";
import { parseCboeIndexes } from "../sources/cboeIndexes.source.js";
import { SOURCE_IDS, TickerSourceError } from "../types.js";

/**
 * One suite per adapter, each on its own small fixture.
 *
 * The recurring theme: classification must come from the SOURCE's own metadata.
 * QQQ is an ETF because the directory's ETF column says so, and SPX is an index
 * because it came from an index directory — not because of anything in either
 * name. A name-based rule would misfile every fund that omits "ETF" and would
 * drop SPX, whose official name is "Standard & Poor's 500".
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** Fixtures are small; the truncation floors would reject them unpadded. */
function pad(text: string, rows: number, make: (i: number) => string): string {
  const filler = Array.from({ length: rows }, (_, i) => make(i)).join("\n");
  return text.includes("File Creation Time")
    ? text.replace(/^File Creation Time.*$/m, `${filler}\nFile Creation Time: 0807202621:31||||||`)
    : `${text}\n${filler}`;
}

const nasdaqText = () =>
  pad(read("nasdaqlisted.sample.txt"), MIN_EXPECTED_NASDAQ_RECORDS, (i) =>
    `NPAD${i}|Padding Corp ${i} - Common Stock|Q|N|N|100|N|N`);

const otherText = () =>
  pad(read("otherlisted.sample.txt"), MIN_EXPECTED_OTHER_LISTED_RECORDS, (i) =>
    `OPAD${i}|Padding Corp ${i}|N|OPAD${i}|N|100|N|OPAD${i}`);

const byId = (records: { symbol: string }[]) => new Map(records.map((r) => [r.symbol, r as never]));

// ── NASDAQ LISTED ───────────────────────────────────────────────────────────

describe("nasdaqListed source", () => {
  const parsed = () => parseNasdaqListed(nasdaqText());

  it("classifies from the ETF column, not the name", () => {
    const map = byId(parsed().records) as Map<string, { securityType: string }>;
    assert.equal(map.get("QQQ")?.securityType, "ETF");
    assert.equal(map.get("NVDA")?.securityType, "STOCK");
    assert.equal(map.get("MSFT")?.securityType, "STOCK");
  });

  it("labels the exchange NASDAQ and stamps its own source id", () => {
    const nvda = parsed().records.find((r) => r.symbol === "NVDA");
    assert.equal(nvda?.exchange, "NASDAQ");
    assert.equal(nvda?.source, SOURCE_IDS.nasdaqListed);
  });

  it("imports the symbols this source is expected to supply", () => {
    const symbols = parsed().records.map((r) => r.symbol);
    for (const expected of ["QQQ", "NVDA", "MSFT", "AAPL", "AMD", "TSLA", "RDDT", "GOOG", "GOOGL"]) {
      assert.ok(symbols.includes(expected), `${expected} must come from the source`);
    }
  });

  it("rejects test issues", () => {
    assert.ok(!parsed().records.some((r) => r.symbol === "ZXZZT"));
    assert.equal(parsed().testIssuesSkipped, 1);
  });

  it("normalizes a padded symbol and drops unusable rows", () => {
    const symbols = parsed().records.map((r) => r.symbol);
    assert.ok(symbols.includes("PADDED"));
    assert.ok(!symbols.includes("NONAME"));
    assert.equal(parsed().malformedSkipped, 2);
    assert.equal(parsed().duplicatesSkipped, 1);
  });

  it("drops the File Creation Time footer and reads its timestamp", () => {
    const result = parsed();
    assert.ok(!result.records.some((r) => r.companyName.startsWith("File Creation")));
    assert.equal(result.sourceCreatedAt?.getFullYear(), 2026);
  });

  it("refuses a payload it cannot trust", () => {
    assert.throws(() => parseNasdaqListed(""), TickerSourceError);
    assert.throws(() => parseNasdaqListed("<html>503</html>"), TickerSourceError);
    // Missing a required column.
    assert.throws(
      () => parseNasdaqListed(nasdaqText().replace("ETF|NextShares", "Renamed|NextShares")),
      /missing required column/,
    );
    // Parses cleanly, far too small — the case that would empty an exchange.
    assert.throws(
      () =>
        parseNasdaqListed(
          `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
NVDA|NVIDIA Corporation|Q|N|N|100|N|N
File Creation Time: 0807202621:31|||||||`,
        ),
      /truncated/,
    );
  });
});

// ── OTHER LISTED ────────────────────────────────────────────────────────────

describe("otherListed source", () => {
  const parsed = () => parseOtherListed(otherText());

  it("maps every documented exchange code", () => {
    assert.deepEqual(labelForExchangeCode("N"), { label: "NYSE", known: true });
    assert.deepEqual(labelForExchangeCode("A"), { label: "NYSE_AMERICAN", known: true });
    assert.deepEqual(labelForExchangeCode("P"), { label: "NYSE_ARCA", known: true });
    assert.deepEqual(labelForExchangeCode("Z"), { label: "BATS_CBOE", known: true });
    assert.deepEqual(labelForExchangeCode("V"), { label: "IEX", known: true });
  });

  it("imports all of them, not just NYSE", () => {
    const map = byId(parsed().records) as Map<string, { exchange: string }>;
    assert.equal(map.get("IBM")?.exchange, "NYSE");
    assert.equal(map.get("AMEXCO")?.exchange, "NYSE_AMERICAN");
    assert.equal(map.get("SPY")?.exchange, "NYSE_ARCA");
    assert.equal(map.get("BATSCO")?.exchange, "BATS_CBOE");
    assert.equal(map.get("IEXCO")?.exchange, "IEX");
  });

  it("imports SPY as an NYSE Arca ETF", () => {
    const spy = parsed().records.find((r) => r.symbol === "SPY");
    assert.equal(spy?.exchange, "NYSE_ARCA");
    assert.equal(spy?.securityType, "ETF");
    assert.equal(spy?.source, SOURCE_IDS.otherListed);
  });

  it("never files an unknown code as NYSE", () => {
    const result = parsed();
    const newVenue = result.records.find((r) => r.symbol === "NEWVENUE");
    assert.equal(newVenue?.exchange, "UNKNOWN_M", "a new venue must be visibly provisional");
    assert.deepEqual(result.unknownExchangeCodes, { M: 1 }, "and reported for a decision");
  });

  it("rejects test issues regardless of exchange", () => {
    const symbols = parsed().records.map((r) => r.symbol);
    assert.ok(!symbols.includes("TESTX"));
    assert.ok(!symbols.includes("CTEST.E"));
  });

  it("preserves legitimate market punctuation", () => {
    const symbols = parsed().records.map((r) => r.symbol);
    assert.ok(symbols.includes("AAC.U"), "unit");
    assert.ok(symbols.includes("ABR$D"), "preferred series");
  });

  it("refuses a payload it cannot trust", () => {
    assert.throws(() => parseOtherListed(""), TickerSourceError);
    assert.throws(
      () => parseOtherListed(otherText().replace("Exchange|", "Venue|")),
      /missing required column/,
    );
    assert.throws(
      () =>
        parseOtherListed(
          `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
IBM|International Business Machines|N|IBM|N|100|N|IBM
File Creation Time: 0807202621:31||||||`,
        ),
      /truncated/,
    );
  });
});

// ── CBOE INDEXES ────────────────────────────────────────────────────────────

describe("cboeIndexes source", () => {
  const parsed = () => parseCboeIndexes(read("cboe-indexes.sample.json"));

  it("classifies everything as INDEX on CBOE", () => {
    for (const record of parsed().records) {
      assert.equal(record.securityType, "INDEX");
      assert.equal(record.exchange, "CBOE");
      assert.equal(record.source, SOURCE_IDS.cboeIndexes);
    }
  });

  it("supplies the index symbols Reddit actually discusses", () => {
    const symbols = parsed().records.map((r) => r.symbol);
    for (const expected of ["SPX", "VIX", "RUT", "XSP", "DJX"]) {
      assert.ok(symbols.includes(expected), `${expected} must be present`);
    }
  });

  it("keeps the official name", () => {
    const spx = parsed().records.find((r) => r.symbol === "SPX");
    assert.equal(spx?.companyName, "Standard & Poor's 500");
  });

  it("normalizes a caret prefix and padding", () => {
    const symbols = parsed().records.map((r) => r.symbol);
    assert.ok(symbols.includes("RVX"), "^RVX must not become a separate symbol");
    assert.ok(symbols.includes("VVIX"));
  });

  it("falls back to the description when a name is missing", () => {
    const only = parsed().records.find((r) => r.symbol === "DESCONLY");
    assert.equal(only?.companyName, "Falls back to the description");
  });

  it("drops duplicates and unusable entries", () => {
    const result = parsed();
    assert.equal(result.records.filter((r) => r.symbol === "SPX").length, 1);
    assert.equal(result.duplicatesSkipped, 1);
    assert.ok(!result.records.some((r) => r.symbol === "NONAME"));
  });

  it("refuses anything that is not the index directory", () => {
    assert.throws(() => parseCboeIndexes(""), TickerSourceError);
    assert.throws(() => parseCboeIndexes("<html>Service Unavailable</html>"), /not valid JSON/);
    assert.throws(() => parseCboeIndexes('{"unexpected":"shape"}'), /not a list/);
    assert.throws(() => parseCboeIndexes("[]"), /zero index symbols/);
  });

  it("refuses a payload that parses but lacks SPX", () => {
    // Valid JSON, plausible size, wrong data. Without this check the sweep
    // would deactivate SPX against a stranger's payload.
    const impostor = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ index_symbol: `FAKE${i}`, name: `Fake ${i}` })),
    );
    assert.throws(() => parseCboeIndexes(impostor), /does not contain SPX/);
  });

  it("accepts a future { data: [...] } envelope", () => {
    const wrapped = JSON.stringify({ data: JSON.parse(read("cboe-indexes.sample.json")) });
    assert.ok(parseCboeIndexes(wrapped).records.some((r) => r.symbol === "SPX"));
  });
});
