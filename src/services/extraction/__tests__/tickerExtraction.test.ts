import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCatalog,
  displayable,
  extractFromParts,
  extractTickerMatches,
  DISPLAY_THRESHOLD,
} from "../tickerExtraction.service.js";

/**
 * These are the acceptance cases for the feature, written as the specification
 * states them. The theme running through all of them: a wrong ticker is worse
 * than a missing one, because the association feeds mention counts, sentiment
 * aggregation, Popular Tickers, Arena and search — not just a badge.
 */

const catalog = buildCatalog(
  [
    { ticker: "NVDA" },
    { ticker: "AMD" },
    { ticker: "MSFT" },
    { ticker: "AAPL" },
    { ticker: "AMZN" },
    { ticker: "META" },
    { ticker: "RDDT" },
    { ticker: "UBER" },
    { ticker: "PLTR" },
    { ticker: "GOOG" },
    { ticker: "GOOGL" },
    { ticker: "TGT" },
    { ticker: "AI", isCommonWord: true },
    { ticker: "ON", isCommonWord: true },
    { ticker: "F", isCommonWord: true },
  ],
  [
    { alias: "nvidia", ticker: "NVDA" },
    { alias: "microsoft", ticker: "MSFT" },
    { alias: "palantir", ticker: "PLTR" },
    { alias: "google", ticker: "GOOGL" },
    { alias: "alphabet", ticker: "GOOGL" },
    { alias: "apple", ticker: "AAPL", requiresContext: true },
    { alias: "amazon", ticker: "AMZN", requiresContext: true },
    { alias: "meta", ticker: "META", requiresContext: true },
    { alias: "target corp", ticker: "TGT" },
    { alias: "reddit", ticker: "RDDT", requiresContext: true },
    { alias: "c3.ai", ticker: "AI" },
  ],
);

const shown = (text: string) =>
  displayable(extractTickerMatches(text, catalog)).map((m) => m.symbol);

describe("cashtags and plain symbols", () => {
  it("reads a cashtag", () => {
    assert.deepEqual(shown("Just bought $NVDA calls."), ["NVDA"]);
  });

  it("reads a bare symbol", () => {
    assert.deepEqual(shown("NVDA versus AMD for the next quarter."), ["NVDA", "AMD"]);
  });

  it("REJECTS a cashtag that is not a real security", () => {
    // The old extractor accepted any 1-5 letters after a `$`, which is how
    // DRAM, SPCX and BURU ended up stored as securities.
    assert.deepEqual(shown("$DRAM prices are up and $SPCX is a scam"), []);
  });

  it("rejects finance jargon that looks like a symbol", () => {
    assert.deepEqual(shown("The CEO discussed the IPO."), []);
    assert.deepEqual(shown("My DD says EPS beat, IMO the ATH is in, TA is useless"), []);
    assert.deepEqual(shown("USD and GDP and the SEC and the FED"), []);
  });

  it("does not treat every uppercase word as a ticker", () => {
    assert.deepEqual(shown("THIS IS A LOUD OPINION ABOUT NOTHING"), []);
  });
});

describe("common-word symbols need context", () => {
  it("does not badge a bare AI", () => {
    assert.deepEqual(shown("AI is changing everything."), []);
  });

  it("rejects even 'AI stock', because on this corpus it means the sector", () => {
    // Measured, not assumed: a sample of every surviving bare-AI match in the
    // live database was artificial intelligence, never C3.ai.
    assert.deepEqual(shown("AI stock ripped after earnings"), []);
    assert.deepEqual(shown("AI spending is out of control"), []);
  });

  it("accepts AI from evidence the author supplied", () => {
    assert.deepEqual(shown("$AI earnings tomorrow"), ["AI"]);
    assert.deepEqual(shown("c3.ai reported last night"), ["AI"]);
  });

  it("accepts an explicit cashtag regardless", () => {
    assert.deepEqual(shown("$AI to the moon"), ["AI"]);
  });

  it("still records the weak match internally", () => {
    // Rejected for display, kept for review — that record is what makes the
    // threshold tunable later instead of guessed at.
    const all = extractTickerMatches("AI is changing everything.", catalog);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.symbol, "AI");
    assert.ok(all[0]!.confidence < DISPLAY_THRESHOLD);
  });

  it("does not badge ordinary prose containing ON or F", () => {
    assert.deepEqual(shown("ON the way home I got an F on my test"), []);
  });
});

/**
 * Every case here is a real headline from the database that the first version
 * of this extractor got wrong. The gate it shipped with asked "is this text
 * financial", which on r/wallstreetbets is always true — it produced 168 C3.ai
 * badges and 50 Target Corp. badges before these were written.
 */
describe("false positives found in live data", () => {
  it("does not read artificial intelligence as C3.ai", () => {
    // The Google headline DOES mention a company, so the assertion is about the
    // absence of AI specifically — not an empty result.
    assert.ok(
      !shown("Google Cloud's 82% YoY Surge: The AI Cloud Consolidation Wave is Here?").includes("AI"),
    );
    assert.deepEqual(shown("Frequency AI Ratio Tracker (FART) stategy"), []);
    assert.deepEqual(shown("Big tech paper gains from AI"), []);
    assert.deepEqual(shown("AI is changing everything, should I buy AI?"), []);
  });

  it("does not harvest Target Corp. from the phrase 'price target'", () => {
    assert.deepEqual(shown("HSBC Started Covering SpaceX With a $115 Price Target"), []);
    assert.deepEqual(shown("My price targets for next quarter"), []);
    assert.deepEqual(shown("revenue targets were missed"), []);
    // These three survived two rounds of context-tightening before the bare
    // "target" alias was dropped as unsalvageable.
    assert.deepEqual(shown("covered calls that target ~1% per holding"), []);
    assert.deepEqual(shown("**$200m Revenue Target for 2026**"), []);
    assert.deepEqual(shown("My Target: $70 by December"), []);
  });

  it("still reads the genuine mentions those rules must not cost", () => {
    assert.deepEqual(shown("Target Corp beat on same-store sales"), ["TGT"]);
    assert.deepEqual(shown("Meta is trading at a discount."), ["META"]);
  });
});

describe("company names", () => {
  it("maps an unambiguous company name", () => {
    assert.deepEqual(shown("Nvidia earnings look strong."), ["NVDA"]);
  });

  it("maps an ambiguous name only with financial context", () => {
    assert.deepEqual(shown("I bought Apple stock."), ["AAPL"]);
    assert.deepEqual(shown("I ate an apple."), []);
  });

  it("keeps Amazon the region out of the feed", () => {
    assert.deepEqual(shown("We hiked through the Amazon rainforest."), []);
    assert.deepEqual(shown("Amazon shares fell after guidance."), ["AMZN"]);
  });

  it("keeps meta the adjective out of the feed", () => {
    assert.deepEqual(shown("This post is very meta."), []);
    assert.deepEqual(shown("Meta is trading at a discount."), ["META"]);
  });

  it("does not match a name embedded in another word", () => {
    assert.deepEqual(shown("His metabolism is fast."), []);
  });

  it("requires the cue to be NEAR the mention, not anywhere in the post", () => {
    // A long NVDA writeup must not turn an unrelated "Target" at the end into
    // TGT just because the word "stock" appeared 2,000 characters earlier.
    const far = `I bought NVDA stock today. ${"filler words here. ".repeat(60)}Then I drove to Apple for a new phone.`;
    assert.deepEqual(shown(far), ["NVDA"]);
  });
});

describe("Alphabet share classes — the documented rule", () => {
  it("maps the company name to GOOGL only, never both", () => {
    // Attaching GOOG and GOOGL to one mention would double the company's
    // mention count and skew Popular Tickers and Arena.
    assert.deepEqual(shown("Alphabet earnings were strong."), ["GOOGL"]);
    assert.deepEqual(shown("Google stock is cheap here."), ["GOOGL"]);
  });

  it("honours an explicitly stated share class", () => {
    assert.deepEqual(shown("$GOOG calls"), ["GOOG"]);
  });
});

describe("duplicates and ordering", () => {
  it("collapses repeated mentions of one company to a single match", () => {
    assert.deepEqual(shown("$NVDA NVDA Nvidia"), ["NVDA"]);
  });

  it("keeps the strongest source when a symbol appears several ways", () => {
    const [match] = extractTickerMatches("Nvidia is great, $NVDA to the moon", catalog);
    assert.equal(match?.symbol, "NVDA");
    assert.equal(match?.source, "cashtag");
  });

  it("orders cashtags first, then by first appearance", () => {
    assert.deepEqual(
      shown("NVDA looks stronger than AMD, but I bought $MSFT."),
      ["MSFT", "NVDA", "AMD"],
    );
  });

  it("orders by first appearance when no cashtag is present", () => {
    assert.deepEqual(shown("NVDA looks stronger than AMD this quarter"), ["NVDA", "AMD"]);
  });
});

describe("multi-field extraction", () => {
  it("treats title and body as one document", () => {
    const symbols = extractFromParts(catalog, "NVDA thesis", "and $AMD too").map(
      (m) => m.symbol,
    );
    assert.deepEqual(symbols, ["AMD", "NVDA"]);
  });

  it("survives null and empty fields", () => {
    assert.deepEqual(extractFromParts(catalog, null, undefined, ""), []);
    assert.deepEqual(extractTickerMatches(null, catalog), []);
    assert.deepEqual(extractTickerMatches("   ", catalog), []);
  });
});

describe("catalog integrity", () => {
  it("drops an alias pointing at a symbol outside the catalog", () => {
    const c = buildCatalog([{ ticker: "NVDA" }], [{ alias: "ghost", ticker: "ZZZZ" }]);
    assert.deepEqual(extractTickerMatches("ghost company", c), []);
  });

  it("finds nothing at all when the catalog is empty", () => {
    const empty = buildCatalog([], []);
    assert.deepEqual(extractTickerMatches("$NVDA NVDA Nvidia", empty), []);
  });

  it("carries the matched text so a false positive can be traced", () => {
    const [m] = extractTickerMatches("bought $NVDA today", catalog);
    assert.equal(m?.matchedText, "$NVDA");
    assert.equal(m?.source, "cashtag");
  });
});
