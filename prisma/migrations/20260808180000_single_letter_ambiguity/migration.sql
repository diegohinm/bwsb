-- Apply the ambiguity rule to symbols already in the catalog.
--
-- The rule lives in config/tickers/ambiguousTickers.ts and the daily refresh
-- writes it on every import. This backfills the rows that were imported before
-- the rule existed, so the fix does not have to wait for the next successful
-- refresh — and so it survives one that fails.
--
-- THE RULE, restated here because this file has to encode it:
--
--   isAmbiguous = length(symbol) = 1  OR  symbol IN ('AI', 'ON', 'IT')
--
-- WHY SINGLE LETTERS
--
-- A lone capital letter is indistinguishable from ordinary prose. With the full
-- US catalog loaded, the live 24-hour Top Tickers ranking came out
-- `S, A, GOOGL, U, P` — four of the top five were letters scraped out of
-- capitalised sentences. Agilent (A), SentinelOne (S) and Unity (U) are real
-- companies and stay in the catalog; only BARE mentions of them are refused.
-- `$A` still resolves.

UPDATE "tickers"
   SET "is_ambiguous" = true,
       "updated_at"   = now()
 WHERE "is_ambiguous" = false
   AND (length("ticker") = 1 OR "ticker" IN ('AI', 'ON', 'IT'));

-- A symbol must never be silently un-flagged: nothing here clears the column,
-- and the importer recomputes it from the same rule rather than trusting the
-- stored value.
