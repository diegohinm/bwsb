import "../../../providers/reddit/__tests__/helpers.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextCatchUpPosition } from "../redditSync.service.js";

/**
 * THE DEADLOCK THIS FILE EXISTS TO PREVENT.
 *
 * The archive is queried with `after = checkpoint - overlap`, ascending, capped
 * at one page. The overlap is what stops same-second items being lost at an
 * EXCLUSIVE boundary — but it also means the first page of every tick starts
 * slightly BEHIND the checkpoint and re-reads content already stored.
 *
 * Normally that costs a couple of duplicate rows. It stops being harmless the
 * moment the stream produces more items per overlap interval than a page can
 * hold: then the ENTIRE page lands at or before the checkpoint, every row is a
 * duplicate, and the durable checkpoint — correctly — refuses to rewind to
 * accommodate it. Rebuild the next window from that unchanged checkpoint and
 * you get a byte-identical request. Forever.
 *
 * The symptom is the cruel part: `new=0 duplicates=100` is exactly what a quiet
 * community looks like, so a permanently wedged stream reports itself healthy,
 * lag stays nominal, no failure is counted and the fallback never engages.
 *
 * The fix is that PAGINATION POSITION and DURABLE POSITION are different
 * things. The checkpoint must never rewind; the walk within a tick must be able
 * to move forward through ground the checkpoint already covers.
 */

const T = (iso: string): Date => new Date(iso);

describe("catch-up walks forward through a full page of duplicates", () => {
  it("CONTINUES when a full page yielded nothing new", () => {
    // THE REGRESSION. Stopping here is what wedges the stream: the page is full,
    // so there is demonstrably more past its edge, and every row being known
    // only says the overlap was wider than one page.
    const next = nextCatchUpPosition({
      hasMore: true,
      newItems: 0,
      newestSeenAt: T("2026-09-12T15:30:00Z"),
      position: undefined,
    });
    assert.deepEqual(
      next,
      T("2026-09-12T15:30:00Z"),
      "a FULL page of duplicates must advance the walk, not end it",
    );
  });

  it("pages from where the previous page ended, not from the checkpoint", () => {
    // Re-deriving each page's window from the checkpoint is the bug: the
    // checkpoint has not moved, so page 2 would repeat page 1 exactly.
    const next = nextCatchUpPosition({
      hasMore: true,
      newItems: 40,
      newestSeenAt: T("2026-09-12T15:31:00Z"),
      position: T("2026-09-12T15:30:00Z"),
    });
    assert.deepEqual(next, T("2026-09-12T15:31:00Z"));
  });

  it("STOPS on a short page — that is what 'caught up' actually looks like", () => {
    const next = nextCatchUpPosition({
      hasMore: false,
      newItems: 7,
      newestSeenAt: T("2026-09-12T15:31:00Z"),
      position: T("2026-09-12T15:30:00Z"),
    });
    assert.equal(next, null);
  });

  it("STOPS rather than spinning when the position does not move forward", () => {
    // A source that keeps reporting the same boundary timestamp must not be
    // walked in circles until the page budget is exhausted.
    const next = nextCatchUpPosition({
      hasMore: true,
      newItems: 0,
      newestSeenAt: T("2026-09-12T15:30:00Z"),
      position: T("2026-09-12T15:30:00Z"),
    });
    assert.equal(next, null, "a non-advancing position must end the walk");
  });

  it("STOPS when the position would go backwards", () => {
    const next = nextCatchUpPosition({
      hasMore: true,
      newItems: 0,
      newestSeenAt: T("2026-09-12T15:29:00Z"),
      position: T("2026-09-12T15:30:00Z"),
    });
    assert.equal(next, null);
  });

  it("STOPS when the source reports no position at all", () => {
    // The metered provider has no server-side window, so it cannot be paged.
    const next = nextCatchUpPosition({
      hasMore: true,
      newItems: 0,
      newestSeenAt: null,
      position: undefined,
    });
    assert.equal(next, null);
  });

  it("terminates: a busy stream walks strictly forward every page", () => {
    // The property that makes the loop safe — each step is strictly later than
    // the last, so with a bounded page budget the walk always ends.
    let position: Date | undefined;
    const seen: number[] = [];

    for (let page = 0; page < 5; page += 1) {
      // Every page is full and entirely duplicate: the pathological market-open
      // case where the overlap alone exceeds one page.
      const next = nextCatchUpPosition({
        hasMore: true,
        newItems: 0,
        newestSeenAt: new Date(T("2026-09-12T15:30:00Z").getTime() + page * 30_000),
        position,
      });
      if (!next) break;
      position = next;
      seen.push(next.getTime());
    }

    assert.equal(seen.length, 5, "the walk must make progress on every page");
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]! > seen[i - 1]!, "each page must start strictly later than the last");
    }
  });
});
