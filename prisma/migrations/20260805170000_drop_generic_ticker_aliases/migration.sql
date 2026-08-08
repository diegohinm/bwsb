-- Remove company aliases that are ordinary trading vocabulary.
--
-- MEASURED, NOT ASSUMED. Every one of these was checked against the live
-- corpus after the context gate had already been tightened twice, and each was
-- still producing only false positives:
--
--   target  -> "profit targets", "revenue target", "my target: $70",
--              "covered calls that target ~1% per holding"
--   block   -> "block trade", "blocked out"
--   square  -> "square up", "back to square one"
--   arm     -> "arm of the business", "strong arm"
--
-- The problem is not the context test. These words are verbs and common nouns
-- INSIDE financial writing, so the surrounding text is exactly as financial
-- when they mean the company as when they do not. No amount of adjacency
-- separates them.
--
-- The companies stay reachable through their full names below and through an
-- explicit cashtag ($TGT, $SQ, $ARM), which is evidence the author supplied.
-- Losing a bare "Target" mention costs one badge; keeping it corrupted mention
-- counts, Popular Tickers and Arena for every reader.

DELETE FROM "ticker_aliases" WHERE "alias" IN ('target', 'block', 'square', 'arm');

INSERT INTO "ticker_aliases" ("alias", "ticker", "requires_context") VALUES
    ('target corp',        'TGT',  false),
    ('target corporation', 'TGT',  false),
    ('block inc',          'SQ',   false),
    ('arm holdings',       'ARM',  false)
ON CONFLICT ("alias") DO NOTHING;
