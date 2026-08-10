import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeSearchQuery, searchTerms } from "../searchQuery.js";
import {
  classifyThreadType,
  isDiscussionThreadType,
  DISCUSSION_THREAD_TYPES,
} from "../../social/dailyDiscussion.service.js";

/**
 * "UBER" worked and "$UBER" found nothing, because the search matched the
 * literal string. People write cashtags — it is how tickers are written on
 * Reddit — so the dollar sign turned a working query into a dead one.
 */

const CATALOG = new Set(["UBER", "NVDA", "AI", "A"]);
const known = (s: string) => CATALOG.has(s);
const normalize = (q: string) => normalizeSearchQuery(q, known);

describe("cashtag normalization", () => {
  it("treats $UBER exactly like UBER", () => {
    const r = normalize("$UBER");
    assert.equal(r.normalizedText, "UBER");
    assert.deepEqual(r.tickerSymbols, ["UBER"]);
  });

  it("is case-insensitive", () => {
    assert.deepEqual(normalize("$uber").tickerSymbols, ["UBER"]);
    assert.equal(normalize("$uber").normalizedText, "UBER");
  });

  it("keeps the surrounding words in a mixed query", () => {
    const r = normalize("calls on $UBER");
    assert.equal(r.normalizedText, "calls on UBER");
    assert.deepEqual(r.tickerSymbols, ["UBER"]);
    // The raw form is kept so a post that literally wrote "$UBER" still matches.
    assert.equal(r.raw, "calls on $UBER");
  });

  it("searches both spellings", () => {
    assert.deepEqual(searchTerms(normalize("$UBER")), ["$UBER", "UBER"]);
    // Nothing to rewrite: one term, not a pointless duplicate.
    assert.deepEqual(searchTerms(normalize("UBER")), ["UBER"]);
  });
});

describe("what must NOT become a ticker search", () => {
  it("leaves currency amounts alone", () => {
    for (const money of ["$100", "$5000", "$1.50"]) {
      const r = normalize(money);
      assert.deepEqual(r.tickerSymbols, [], `${money} is money, not a security`);
      assert.equal(r.normalizedText, money, "the text must survive untouched");
    }
  });

  it("leaves symbol-shaped words that are not securities alone", () => {
    for (const word of ["$CEO", "$USD", "$IPO"]) {
      const r = normalize(word);
      assert.deepEqual(r.tickerSymbols, []);
      assert.equal(r.normalizedText, word, "someone searching $USD meant the word");
    }
  });

  it("does not strip a dollar sign glued to other text", () => {
    const r = normalize("price$UBERtoday");
    assert.deepEqual(r.tickerSymbols, [], "not a standalone cashtag");
  });

  it("handles an empty query", () => {
    const r = normalize("");
    assert.deepEqual(r.tickerSymbols, []);
    assert.deepEqual(searchTerms(r), []);
  });

  it("collapses a symbol named twice", () => {
    assert.deepEqual(normalize("$UBER and $UBER again").tickerSymbols, ["UBER"]);
  });
});

/**
 * WHICH recurring thread a post is. Decided by the worker and stored — a
 * `title.includes("tomorrow")` in the browser would drift the moment the
 * subreddit rewords a title and would label ordinary posts.
 */
describe("recurring thread classification", () => {
  const wsb = (title: string, flair?: string) => classifyThreadType(title, "wallstreetbets", flair);

  it("separates the three threads", () => {
    assert.equal(wsb("What Are Your Moves Today, August 9, 2026?"), "DAILY");
    assert.equal(wsb("Daily Discussion Thread for August 9, 2026"), "DAILY");
    assert.equal(wsb("What Are Your Moves Tomorrow, August 10, 2026?"), "TOMORROW");
    assert.equal(wsb("Weekend Discussion Thread for the Weekend of August 8-9"), "WEEKEND");
  });

  it("checks the more specific title first", () => {
    // "Tomorrow" must not be swallowed by a looser "moves" rule.
    assert.equal(wsb("What Are Your Moves Tomorrow, December 31, 2026?"), "TOMORROW");
  });

  it("lets the title override a broader flair", () => {
    // Flaired "Daily Discussion" but titled Tomorrow — it is the evening thread.
    assert.equal(wsb("What Are Your Moves Tomorrow, August 10, 2026?", "Daily Discussion"), "TOMORROW");
  });

  it("returns null for an ordinary post that mentions tomorrow", () => {
    assert.equal(wsb("My moves tomorrow are simple: buy NVDA"), null);
    assert.equal(wsb("Weekend thoughts on the market"), null);
    assert.equal(wsb("NVDA calls before earnings?"), null);
  });

  it("returns null outside r/wallstreetbets", () => {
    assert.equal(classifyThreadType("Daily Discussion Thread", "stocks"), null);
    assert.equal(classifyThreadType("What Are Your Moves Tomorrow", "investing"), null);
  });

  it("falls back to DAILY for a megathread whose title matches no shape", () => {
    // Recognized by flair only. DAILY is the honest default — guessing WEEKEND
    // would file weekday content under a heading that says otherwise.
    assert.equal(wsb("Some unusual megathread title", "Megathread"), "DAILY");
  });

  it("exposes exactly the three types", () => {
    assert.deepEqual([...DISCUSSION_THREAD_TYPES], ["DAILY", "TOMORROW", "WEEKEND"]);
    assert.equal(isDiscussionThreadType("TOMORROW"), true);
    assert.equal(isDiscussionThreadType("MONTHLY"), false);
  });
});
