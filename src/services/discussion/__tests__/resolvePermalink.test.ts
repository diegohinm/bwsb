import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolvePermalink } from "../discussionRead.service.js";

/**
 * The Open-on-Reddit link recovery.
 *
 * A stored `url` always wins. When a source recorded none, the FIRST real
 * Reddit URL in the body is surfaced — never fabricated. The host allow-list is
 * the interesting part: any official Reddit host must be accepted (including the
 * share host `sh.reddit.com`, which real megathread bodies use), while a
 * look-alike domain must not slip through.
 */
describe("resolvePermalink", () => {
  it("prefers the stored url verbatim", () => {
    assert.equal(
      resolvePermalink("https://www.reddit.com/r/wsb/comments/a1", "ignored body"),
      "https://www.reddit.com/r/wsb/comments/a1",
    );
  });

  it("recovers a share-host (sh.reddit.com) link from the body", () => {
    const body =
      "Rollover thread. Continue here: https://sh.reddit.com/r/wallstreetbets/comments/1vgi8wm";
    assert.equal(
      resolvePermalink(null, body),
      "https://sh.reddit.com/r/wallstreetbets/comments/1vgi8wm",
    );
  });

  it("accepts the other official Reddit subdomains and redd.it short links", () => {
    for (const url of [
      "https://reddit.com/r/stocks/comments/x",
      "https://old.reddit.com/r/stocks/comments/x",
      "https://np.reddit.com/r/stocks/comments/x",
      "https://new.reddit.com/r/stocks/comments/x",
      "https://m.reddit.com/r/stocks/comments/x",
      "https://redd.it/1vgi8wm",
    ]) {
      assert.equal(resolvePermalink(null, `see ${url} for more`), url);
    }
  });

  it("recovers the bare URL from a Markdown self-link, dropping the `](` residue", () => {
    // A body that wrote its link as `[url](url)` must NOT yield the middle
    // `…/faq](https://…/faq` string — that produced an unnavigable href before.
    const body =
      "See the rules: [https://www.reddit.com/r/investing/wiki/faq](https://www.reddit.com/r/investing/wiki/faq)";
    assert.equal(
      resolvePermalink(null, body),
      "https://www.reddit.com/r/investing/wiki/faq",
    );
  });

  it("strips a trailing paren/period from a link written inline in prose", () => {
    assert.equal(
      resolvePermalink(null, "(source: https://www.reddit.com/r/stocks/comments/abc)."),
      "https://www.reddit.com/r/stocks/comments/abc",
    );
  });

  it("does NOT match a look-alike host masquerading as reddit.com", () => {
    // The trailing slash after the host is required, so the phishing host below
    // (reddit.com is only a label of a different domain) cannot be recovered.
    assert.equal(
      resolvePermalink(null, "https://reddit.com.evil.example/r/wsb/comments/x"),
      null,
    );
    assert.equal(resolvePermalink(null, "https://notreddit.com/r/wsb/comments/x"), null);
  });

  it("returns null when neither a url nor a body link exists", () => {
    assert.equal(resolvePermalink(null, "no links here at all"), null);
    assert.equal(resolvePermalink(null, null), null);
    assert.equal(resolvePermalink("", ""), null);
  });
});
