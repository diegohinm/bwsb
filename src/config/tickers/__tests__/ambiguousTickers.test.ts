import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AMBIGUOUS_SYMBOL_LENGTH,
  MANUAL_AMBIGUOUS_TICKERS,
  isAmbiguousTicker,
} from "../ambiguousTickers.js";
import {
  buildCatalog,
  displayable,
  extractTickerMatches,
} from "../../../services/extraction/tickerExtraction.service.js";

/**
 * Ambiguity is one rule in one file, and these pin both halves of it: the
 * derived single-letter half and the hand-reviewed half.
 *
 * The consequence is what matters. With the full US catalog loaded, the live
 * 24-hour Top Tickers ranking came out `S, A, GOOGL, U, P` — four of the top
 * five were capital letters harvested from ordinary prose.
 */

describe("the single-letter rule", () => {
  it("is derived from length, not from a list", () => {
    assert.equal(AMBIGUOUS_SYMBOL_LENGTH, 1);
    for (const symbol of ["A", "S", "U", "F", "T", "V", "X", "Z"]) {
      assert.equal(isAmbiguousTicker(symbol), true, `${symbol} must be ambiguous`);
    }
  });

  it("covers a symbol nobody has listed yet", () => {
    // The point of deriving it: a one-letter symbol that lists tomorrow is
    // handled the day it arrives, with no one having to notice.
    assert.equal(isAmbiguousTicker("Q"), true);
    assert.equal(isAmbiguousTicker("W"), true);
  });

  it("normalizes before deciding", () => {
    assert.equal(isAmbiguousTicker(" a "), true);
    assert.equal(isAmbiguousTicker("s"), true);
    assert.equal(isAmbiguousTicker(""), false);
  });
});

describe("the hand-reviewed list", () => {
  it("keeps the original three", () => {
    assert.equal(isAmbiguousTicker("AI"), true);
    assert.equal(isAmbiguousTicker("ON"), true);
    assert.equal(isAmbiguousTicker("IT"), true);
  });

  it("covers the measured English-word collisions", () => {
    for (const symbol of [
      "ALL", "ARE", "CAR", "EAT", "FOR", "GO", "HAS",
      "LOVE", "OPEN", "PLAY", "REAL", "RUN", "WELL", "YOU",
    ]) {
      assert.equal(isAmbiguousTicker(symbol), true, `${symbol} must be ambiguous`);
    }
  });

  it("contains only entries that are real listed symbols", () => {
    // A word that is not a ticker has no business here: the detector already
    // refuses anything outside the catalog, so listing it would imply a check
    // that does nothing. A first draft carried 31 such words; they were removed
    // after being measured against the catalog.
    assert.ok(MANUAL_AMBIGUOUS_TICKERS.size > 0);
    for (const banned of ["THE", "BUY", "WORK", "TRUE", "OLD", "WIN"]) {
      assert.ok(
        !MANUAL_AMBIGUOUS_TICKERS.has(banned),
        `${banned} is not an active ticker and must not be listed`,
      );
    }
  });

  it("does not sweep in every short symbol", () => {
    // The rule is one letter OR hand-reviewed — not "every two- or
    // three-letter ticker", which would silence hundreds of real companies.
    for (const symbol of ["MU", "GE", "BA", "KO", "HTZ", "AMD", "SPY", "QQQ"]) {
      assert.equal(isAmbiguousTicker(symbol), false, `${symbol} must stay usable`);
    }
  });

  it("is case-insensitive", () => {
    assert.equal(isAmbiguousTicker("ai"), true);
    assert.equal(isAmbiguousTicker(" On "), true);
  });
});

describe("ordinary symbols stay unambiguous", () => {
  it("leaves real multi-letter tickers alone", () => {
    for (const symbol of ["NVDA", "MSFT", "VWAV", "SPY", "QQQ", "SPX", "AMD", "TSLA"]) {
      assert.equal(isAmbiguousTicker(symbol), false, `${symbol} must NOT be ambiguous`);
    }
  });

  it("does not make a two-letter symbol ambiguous by length alone", () => {
    // Only the hand-reviewed two-letter words are ambiguous; the rest are not.
    assert.equal(isAmbiguousTicker("MU"), false);
    assert.equal(isAmbiguousTicker("GE"), false);
  });
});

/**
 * The detector's half of the contract: an ambiguous symbol may only be accepted
 * on evidence the AUTHOR supplied.
 */
describe("detection", () => {
  const catalog = buildCatalog(
    [
      { ticker: "A", isCommonWord: isAmbiguousTicker("A") },
      { ticker: "S", isCommonWord: isAmbiguousTicker("S") },
      { ticker: "U", isCommonWord: isAmbiguousTicker("U") },
      { ticker: "P", isCommonWord: isAmbiguousTicker("P") },
      { ticker: "AI", isCommonWord: isAmbiguousTicker("AI") },
      { ticker: "ON", isCommonWord: isAmbiguousTicker("ON") },
      { ticker: "IT", isCommonWord: isAmbiguousTicker("IT") },
      { ticker: "NVDA", isCommonWord: isAmbiguousTicker("NVDA") },
      { ticker: "VWAV", isCommonWord: isAmbiguousTicker("VWAV") },
    ],
    [{ alias: "c3.ai", ticker: "AI" }],
  );

  const shown = (text: string) =>
    displayable(extractTickerMatches(text, catalog)).map((m) => m.symbol);

  it("rejects a bare single letter", () => {
    assert.deepEqual(shown("A new opportunity"), []);
    assert.deepEqual(shown("THIS IS A GREAT STOCK"), []);
    assert.deepEqual(shown("S is everywhere"), []);
    assert.deepEqual(shown("U up?"), []);
  });

  it("rejects a bare hand-reviewed word", () => {
    assert.deepEqual(shown("AI is changing everything"), []);
    assert.deepEqual(shown("I bought it ON Friday"), []);
    assert.deepEqual(shown("IT was terrible"), []);
  });

  it("accepts the same symbols as explicit cashtags", () => {
    assert.deepEqual(shown("$A earnings"), ["A"]);
    assert.deepEqual(shown("$S calls"), ["S"]);
    assert.deepEqual(shown("$U puts"), ["U"]);
    assert.deepEqual(shown("$P shares"), ["P"]);
    assert.deepEqual(shown("$AI earnings"), ["AI"]);
    assert.deepEqual(shown("$ON calls"), ["ON"]);
    assert.deepEqual(shown("$IT guidance"), ["IT"]);
  });

  it("accepts an ambiguous symbol from its company name", () => {
    assert.deepEqual(shown("c3.ai reported last night"), ["AI"]);
  });

  it("leaves ordinary tickers working exactly as before", () => {
    assert.deepEqual(shown("NVDA earnings"), ["NVDA"]);
    assert.deepEqual(shown("VWAV filed a trademark"), ["VWAV"]);
  });

  it("rejects rather than storing a hidden association", () => {
    // "Removed" has to mean removed: a low-confidence row still reads as an
    // association to every consumer of the table.
    assert.deepEqual(extractTickerMatches("THIS IS A GREAT STOCK", catalog), []);
    assert.deepEqual(extractTickerMatches("AI is changing everything", catalog), []);
  });

  it("still finds a real ticker in the same sentence as an ambiguous one", () => {
    assert.deepEqual(shown("A great quarter for NVDA"), ["NVDA"]);
  });
});

/**
 * The English-word symbols, on the sentences that produced the contamination.
 */
describe("English-word symbols", () => {
  const words = ["ALL", "ARE", "CAR", "EAT", "FOR", "GO", "HAS", "LOVE",
    "OPEN", "PLAY", "REAL", "RUN", "WELL", "YOU"];
  const catalog = buildCatalog(
    [
      ...words.map((ticker) => ({ ticker, isCommonWord: isAmbiguousTicker(ticker) })),
      { ticker: "NVDA", isCommonWord: isAmbiguousTicker("NVDA") },
    ],
    [],
  );
  const shown = (text: string) =>
    displayable(extractTickerMatches(text, catalog)).map((m) => m.symbol);

  it("rejects a sentence written in capitals", () => {
    assert.deepEqual(shown("ALL OF YOU ARE WRONG"), []);
    assert.deepEqual(shown("OPEN THE APP"), []);
    assert.deepEqual(shown("LOVE THIS"), []);
    assert.deepEqual(shown("GO ALL IN"), []);
    assert.deepEqual(shown("REAL TALK, RUN FOR THE EXIT"), []);
  });

  it("accepts each of them as an explicit cashtag", () => {
    for (const symbol of words) {
      assert.deepEqual(shown(`$${symbol} earnings tomorrow`), [symbol]);
    }
  });

  it("does not break a non-ambiguous ticker in capitals", () => {
    // The whole point: silencing the words must not silence real symbols.
    assert.deepEqual(shown("NVDA IS GOING UP"), ["NVDA"]);
    assert.deepEqual(shown("ALL OF YOU ARE WRONG ABOUT NVDA"), ["NVDA"]);
  });
});
