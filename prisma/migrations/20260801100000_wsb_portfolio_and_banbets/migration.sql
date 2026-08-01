-- WSB Portfolio + WSB Banbets storage.
--
-- Five new tables, nothing altered: the WSB workspace is a new read surface
-- built on top of content the ingestion pipeline already collects, so no
-- existing row is rewritten and no existing query changes shape.
--
-- Four of the five are APPEND-ONLY SNAPSHOTS, following the same contract as
-- `subreddit_pulse_snapshots`: the worker writes one batch per run sharing a
-- `snapshot_at`, and the API reads only the newest batch for a timeframe. A run
-- that fails writes nothing, so the previous snapshot stays servable — that is
-- what makes "preserve prior snapshots on provider failure" true by
-- construction rather than by convention.
--
-- `wsb_banbets` is the exception: a banbet is a LIVE record whose status changes
-- over its lifetime, so it is keyed by `external_id` and upserted in place.
--
-- Identity is stored as `username_hash`. `display_username` is nullable and only
-- populated when the provider's terms permit showing the handle.

-- CreateTable
CREATE TABLE "wsb_portfolio_summary_snapshots" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "timeframe"       TEXT           NOT NULL,
    "traders"         INTEGER        NOT NULL DEFAULT 0,
    "bullish_pct"     DECIMAL(5,2),
    "total_exposure"  DECIMAL,
    "options_pct"     DECIMAL(5,2),
    "stocks_pct"      DECIMAL(5,2),
    "crypto_pct"      DECIMAL(5,2),
    "zero_dte_count"  INTEGER        NOT NULL DEFAULT 0,
    "weekly_count"    INTEGER        NOT NULL DEFAULT 0,
    "swing_count"     INTEGER        NOT NULL DEFAULT 0,
    "leaps_count"     INTEGER        NOT NULL DEFAULT 0,
    "provider"        TEXT,
    "source"          TEXT,
    "is_mock"         BOOLEAN        NOT NULL DEFAULT false,
    "warning"         TEXT,
    "snapshot_at"     TIMESTAMPTZ(6) NOT NULL,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "wsb_portfolio_summary_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wsb_option_position_snapshots" (
    "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
    "timeframe"          TEXT           NOT NULL,
    "underlying"         TEXT           NOT NULL,
    "option_type"        TEXT           NOT NULL,
    "strike"             DECIMAL        NOT NULL,
    "expiration"         DATE           NOT NULL,
    "dte"                INTEGER        NOT NULL,
    "duration_bucket"    TEXT           NOT NULL,
    "holders"            INTEGER        NOT NULL DEFAULT 0,
    "quantity"           INTEGER        NOT NULL DEFAULT 0,
    "estimated_value"    DECIMAL,
    "sentiment_pct"      DECIMAL(5,2),
    "change_pct"         DECIMAL,
    "verification_level" TEXT           NOT NULL DEFAULT 'extracted',
    "provider"           TEXT,
    "source"             TEXT,
    "is_mock"            BOOLEAN        NOT NULL DEFAULT false,
    "snapshot_at"        TIMESTAMPTZ(6) NOT NULL,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "wsb_option_position_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wsb_stock_position_snapshots" (
    "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
    "timeframe"          TEXT           NOT NULL,
    "ticker"             TEXT           NOT NULL,
    "company_name"       TEXT,
    "holders"            INTEGER        NOT NULL DEFAULT 0,
    "shares"             DECIMAL        NOT NULL DEFAULT 0,
    "estimated_value"    DECIMAL,
    "bullish_pct"        DECIMAL(5,2),
    "change_pct"         DECIMAL,
    "top_subreddit"      TEXT,
    "verification_level" TEXT           NOT NULL DEFAULT 'extracted',
    "provider"           TEXT,
    "source"             TEXT,
    "is_mock"            BOOLEAN        NOT NULL DEFAULT false,
    "snapshot_at"        TIMESTAMPTZ(6) NOT NULL,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "wsb_stock_position_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wsb_crypto_position_snapshots" (
    "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
    "timeframe"          TEXT           NOT NULL,
    "asset_name"         TEXT,
    "symbol"             TEXT           NOT NULL,
    "holders"            INTEGER        NOT NULL DEFAULT 0,
    "quantity"           DECIMAL        NOT NULL DEFAULT 0,
    "estimated_value"    DECIMAL,
    "bullish_pct"        DECIMAL(5,2),
    "change_pct"         DECIMAL,
    "verification_level" TEXT           NOT NULL DEFAULT 'extracted',
    "provider"           TEXT,
    "source"             TEXT,
    "is_mock"            BOOLEAN        NOT NULL DEFAULT false,
    "snapshot_at"        TIMESTAMPTZ(6) NOT NULL,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "wsb_crypto_position_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wsb_banbets" (
    "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
    "external_id"      TEXT,
    "username_hash"    TEXT           NOT NULL,
    "display_username" TEXT,
    "app_user_id"      UUID,
    "ticker"           TEXT           NOT NULL,
    "operator"         TEXT           NOT NULL,
    "target_price"     DECIMAL        NOT NULL,
    "side"             TEXT           NOT NULL,
    "status"           TEXT           NOT NULL,
    "result_pct"       DECIMAL,
    "source_url"       TEXT,
    "subreddit"        TEXT,
    "created_at"       TIMESTAMPTZ(6) NOT NULL,
    "expires_at"       TIMESTAMPTZ(6) NOT NULL,
    "resolved_at"      TIMESTAMPTZ(6),
    "provider"         TEXT,
    "source"           TEXT,
    "is_mock"          BOOLEAN        NOT NULL DEFAULT false,
    "fetched_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "wsb_banbets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Every read is "newest snapshot for this timeframe", so timeframe + snapshot_at
-- DESC is the access path for all four snapshot tables.
CREATE INDEX "wsb_portfolio_summary_snapshots_tf_idx"
    ON "wsb_portfolio_summary_snapshots"("timeframe", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "wsb_option_position_snapshots_tf_idx"
    ON "wsb_option_position_snapshots"("timeframe", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "wsb_option_position_snapshots_underlying_idx"
    ON "wsb_option_position_snapshots"("underlying", "snapshot_at" DESC);

-- CreateIndex
-- Serves the All/0DTE/Weekly/Swing/Long filter without re-deriving DTE per row.
CREATE INDEX "wsb_option_position_snapshots_duration_idx"
    ON "wsb_option_position_snapshots"("duration_bucket", "expiration");

-- CreateIndex
CREATE INDEX "wsb_stock_position_snapshots_tf_idx"
    ON "wsb_stock_position_snapshots"("timeframe", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "wsb_stock_position_snapshots_ticker_idx"
    ON "wsb_stock_position_snapshots"("ticker", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "wsb_crypto_position_snapshots_tf_idx"
    ON "wsb_crypto_position_snapshots"("timeframe", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "wsb_crypto_position_snapshots_symbol_idx"
    ON "wsb_crypto_position_snapshots"("symbol", "snapshot_at" DESC);

-- CreateIndex
-- The upsert key: one row per provider-side banbet, updated in place.
CREATE UNIQUE INDEX "wsb_banbets_external_id_key" ON "wsb_banbets"("external_id");

-- CreateIndex
-- "Expiring soon" = open bets ordered by expires_at.
CREATE INDEX "wsb_banbets_status_expires_idx" ON "wsb_banbets"("status", "expires_at");

-- CreateIndex
CREATE INDEX "wsb_banbets_ticker_created_idx" ON "wsb_banbets"("ticker", "created_at" DESC);

-- CreateIndex
-- /api/wsb/banbets/me — the logged-in user's own bets.
CREATE INDEX "wsb_banbets_app_user_idx" ON "wsb_banbets"("app_user_id", "created_at" DESC);

-- Row level security, matching every other table in this database: the API
-- connects as the owner role, and no anon/authenticated policy is granted, so
-- these tables are unreachable from a client-side Supabase key.
ALTER TABLE "wsb_portfolio_summary_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wsb_option_position_snapshots"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wsb_stock_position_snapshots"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wsb_crypto_position_snapshots"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wsb_banbets"                     ENABLE ROW LEVEL SECURITY;
