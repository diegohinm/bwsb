-- Columns the Nasdaq Trader catalog refresh needs.
--
-- WHY THIS EXTENDS `tickers` INSTEAD OF ADDING A `ticker_catalog` TABLE
--
-- The task describes a `TickerCatalog` model, but this database already has the
-- table that model describes: `tickers`, keyed by the symbol itself, with
-- seventeen foreign keys pointing at it — ticker_mentions, ticker_aliases,
-- social_post_tickers, bets, virtual_positions, and the rest. A second catalog
-- would be the duplicate ticker table the task forbids, and every one of those
-- relations would have to choose which of the two to trust.
--
-- So the mapping is:
--   symbol       -> tickers.ticker        (the primary key; already unique)
--   companyName  -> tickers.company_name
--   exchange     -> tickers.exchange
--   isActive     -> tickers.is_active
--   isAmbiguous  -> tickers.is_ambiguous  (added below)
--   lastSeenAt   -> tickers.last_seen_at  (added below)
--   securityType -> tickers.security_type (added below, left NULL)
--
-- `is_ambiguous` is NOT the same column as the existing `is_common_word`.
-- They overlap in meaning but have different owners and lifecycles:
--   is_common_word  belongs to the Reddit ticker extractor, is curated from
--                   observed false positives, and covers a wider set.
--   is_ambiguous    belongs to this refresh job and is set from one small
--                   config file, exactly as specified.
-- Folding the second onto the first would let a daily import silently erase
-- extraction tuning that was measured against live data. They are kept
-- separate deliberately; consolidating them is a decision for later.

ALTER TABLE "tickers"
    ADD COLUMN IF NOT EXISTS "is_ambiguous"  BOOLEAN NOT NULL DEFAULT false,
    -- NULL means "never seen in a validated import", which is different from
    -- "seen a long time ago" — the two must not look alike.
    ADD COLUMN IF NOT EXISTS "last_seen_at"  TIMESTAMPTZ(6),
    -- Left NULL by the importer: the source's Security Name carries the type in
    -- prose ("Common Stock", "Depositary Shares…"), and deriving a normalized
    -- type from that is guesswork the task explicitly rules out.
    ADD COLUMN IF NOT EXISTS "security_type" TEXT,
    ADD COLUMN IF NOT EXISTS "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- The deactivation sweep filters on exchange + is_active; the reporting query
-- orders by last_seen_at.
CREATE INDEX IF NOT EXISTS "tickers_exchange_active_idx"
    ON "tickers" ("exchange", "is_active");
CREATE INDEX IF NOT EXISTS "tickers_last_seen_idx"
    ON "tickers" ("last_seen_at" DESC);
