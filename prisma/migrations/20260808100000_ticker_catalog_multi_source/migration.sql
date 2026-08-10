-- Provenance for the multi-source ticker catalog.
--
-- WHY `source` IS THE KEY COLUMN OF THIS MIGRATION
--
-- The catalog is now fed by three independent directories. The dangerous
-- operation — marking a symbol inactive because it is absent — is only valid
-- WITHIN the universe that a given source describes. Nasdaq's directory says
-- nothing about whether SPX is still a Cboe index, and Cboe's says nothing
-- about NVDA. Without provenance, a successful NASDAQ refresh would look at
-- SPX, fail to find it, and switch it off.
--
-- So each row records which directory last supplied it, and every deactivation
-- sweep is scoped to one source. Rows with a NULL source predate the importers
-- and are owned by no sweep — they are never deactivated automatically.

ALTER TABLE "tickers"
    ADD COLUMN IF NOT EXISTS "source" TEXT;

-- The per-source sweep filters on (source, is_active); everything else is a
-- lookup the task asks for explicitly.
CREATE INDEX IF NOT EXISTS "tickers_source_active_idx" ON "tickers" ("source", "is_active");
CREATE INDEX IF NOT EXISTS "tickers_security_type_idx" ON "tickers" ("security_type");
CREATE INDEX IF NOT EXISTS "tickers_company_name_idx"  ON "tickers" ("company_name");
CREATE INDEX IF NOT EXISTS "tickers_is_ambiguous_idx"  ON "tickers" ("is_ambiguous");

-- The previous iteration imported NYSE from the Other Listed directory but had
-- nowhere to record that. Claim those rows now, so the first multi-source run
-- reconciles them instead of treating ~2,900 real listings as new.
UPDATE "tickers"
   SET "source" = 'NASDAQ_TRADER_OTHER_LISTED'
 WHERE "source" IS NULL
   AND "exchange" = 'NYSE'
   AND "last_seen_at" IS NOT NULL;
