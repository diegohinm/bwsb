# Ticker extraction

How a Reddit post becomes `$NVDA` on a card, and why the rules are as strict as
they are.

## The pipeline

```
Mindcase / Arctic Shift / Reddit API
        ↓
social normalization              providers/…  →  SocialPostItem
        ↓
persistence                       socialSnapshots.repository.saveSocialItems
        ↓
extraction + validation           extraction/tickerExtraction.service
        ↓
social_post_tickers               tickerAssociations.repository
social_comment_tickers
        ↓
Discussion API                    discussionRead.service
        ↓
TickerBadges                      fwsb/components/discussion
```

Detection happens **once**, during ingestion. The frontend renders the stored
array and never scans text — scanning on render would give a different answer
than the one mention counts, Popular Tickers and Arena were built from.

Extraction runs **after** the content row is committed and every failure path is
swallowed and logged. A post is never lost because its tickers could not be
worked out; `npm run social:backfill-tickers` recovers the association later.

## Storage: a join table *and* an array

`social_post_tickers` is the record — confidence, source, matched text, with a
foreign key to `tickers`. `social_posts.tickers text[]` remains as the
GIN-indexed **display projection**: the subset at or above the display
threshold. Six surfaces already query the array (Discussion, Subreddit Pulse,
ticker social metrics, the strip, trending, Arena) and it answers "which rows
mention X" in one index hit.

Both are written in the same transaction, so no reader sees one without the
other. Verified: 0 rows where the array and the join table disagree.

The FK is the validation. A symbol outside the catalog cannot be stored at all,
so no future caller can reintroduce `$DRAM` or `$SPCX` — both of which were in
the database before this work, because the old extractor accepted any 1–5
letters after a dollar sign.

## The confidence ladder

| Confidence | Example | Shown? |
|---|---|---|
| 0.98 | `$NVDA` — cashtag, catalog-validated | yes |
| 0.92 | `NVDA stock` — symbol with an adjacent security noun | yes |
| 0.85 | `NVDA` — bare symbol, unambiguous in the catalog | yes |
| 0.85 | `Nvidia` — unambiguous company name | yes |
| 0.80 | `Apple stock` — context-gated alias with an adjacent noun | yes |
| 0.55 | `AI stocks` — common-word symbol, bare mention | **no** |
| — | `I ate an apple` — context-gated alias, no adjacent noun | not stored |

`DISPLAY_THRESHOLD = 0.75`. Weak matches are still stored: "we saw this and
rejected it" is what makes the threshold tunable later instead of guessed at.

## Why the gate got strict twice

Both tightenings were driven by measurements against the live corpus, not by
theory.

1. **"Is this text financial?"** produced **168 C3.ai badges**. Every one was
   artificial intelligence. On r/wallstreetbets every post is financial, so the
   test proved nothing.
2. **"Is a security noun adjacent?"** cut it to 57. A sample of those was again
   100% the technology: "AI stocks", "AI spending", "AI Memory Demand".
3. **Current rule** — a symbol flagged `is_common_word` needs evidence the
   *author* supplied: an explicit `$AI` cashtag, or the company name via an
   alias. Bare mentions are recorded below the threshold. Result: **0**.

The same reasoning removed four aliases entirely (`target`, `block`, `square`,
`arm`). They are verbs and common nouns *inside* financial writing, so the
surrounding text is exactly as financial when they mean the company as when
they do not. `Target Corp` and `$TGT` still resolve.

"Price target" is excluded by phrase rather than by context, for the same
reason: it is financial vocabulary containing a company name.

## Alphabet — the documented rule

**"Alphabet" and "Google" both map to `GOOGL`.** It is the voting class, the one
r/wallstreetbets quotes by default, and the class the ticker strip already
carries.

`GOOG` is reachable **only** through an explicit `$GOOG` / `GOOG` mention — an
unambiguous statement of share class by the author.

A company-name mention never attaches both. Two badges for one company would
double the symbol's mention count and skew Popular Tickers and Arena.

## Backfill

```bash
npm run social:backfill-tickers                      # everything
npm run social:backfill-tickers -- --since=2026-08-01 # resume from a cursor
npm run social:backfill-tickers -- --limit=500 --debug
```

Keyset pagination over `fetched_at` (never `skip`), 200 rows per batch, 250 ms
between batches so ingestion and the API keep their share of the pool. Each row's
associations are replaced wholesale, so re-running converges rather than
duplicating. The cursor is printed every batch and returned at the end; a run cut
short resumes with `--since`.

It never runs automatically — not at boot, not on a schedule. Re-extracting
every stored row on every deploy would cost minutes and buy nothing, since
ingestion keeps new content associated on its own.

It refuses to run against an empty catalog, which would otherwise validate
nothing and wipe every existing association.

## Adding to the catalog

Symbols live in `tickers`, names and nicknames in `ticker_aliases`.

- `tickers.is_common_word` — the ticker is also an everyday word (`AI`, `ON`,
  `F`, `T`, `V`). Bare mentions will not be shown; add an alias so the company
  stays reachable by name.
- `ticker_aliases.requires_context` — the alias is also an ordinary word or a
  place (`apple`, `amazon`, `meta`). Needs a security noun beside it.

Before adding a generic word as an alias, check it against real content first.
Four of them did not survive that check.
