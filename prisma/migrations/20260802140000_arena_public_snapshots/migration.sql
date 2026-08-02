-- ARENA public snapshots.
--
-- Two append-only tables that let /arena be a public, read-only page served
-- entirely from precomputed rows:
--
--   arena_ticker_performance_snapshots — the two Top 10 tables. One row per
--   symbol per scope per period. Precomputed because each row joins social
--   mentions, a sentiment split and two delayed market prices; doing that per
--   visitor would be a scan per request, and every visitor must see the same
--   numbers anyway.
--
--   arena_user_performance_snapshots — the public leaderboard. Ranked by RETURN
--   rather than balance, because starting cash differs between users and
--   absolute equity would rank the richest instead of the best.
--
-- `public_after` is the delay gate. The worker stamps it as calculation time
-- plus the public display delay, and every public read filters
-- `public_after <= now()`. A fresh internal equity calculation therefore cannot
-- leak a real-time portfolio value through the leaderboard.
--
-- Prices are nullable on purpose: no eligible delayed snapshot means "—" in the
-- UI, never a fabricated return.

-- CreateTable
CREATE TABLE "arena_ticker_performance_snapshots" (
    "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
    "scope"             TEXT           NOT NULL,
    "period"            TEXT           NOT NULL,
    "period_start"      TIMESTAMPTZ(6) NOT NULL,
    "period_end"        TIMESTAMPTZ(6) NOT NULL,
    "symbol"            TEXT           NOT NULL,
    "rank"              INTEGER        NOT NULL,
    "mentions"          INTEGER        NOT NULL,
    "mention_share_pct" DECIMAL(5,2),
    "subreddit_count"   INTEGER,
    "bullish_pct"       DECIMAL(5,2),
    "neutral_pct"       DECIMAL(5,2),
    "bearish_pct"       DECIMAL(5,2),
    "classified_count"  INTEGER,
    "start_price"       DECIMAL,
    "latest_price"      DECIMAL,
    "performance_pct"   DECIMAL,
    "trend"             JSONB,
    "provider_social"   TEXT,
    "provider_market"   TEXT,
    "display_mode"      TEXT           NOT NULL DEFAULT 'delayed',
    "delay_minutes"     INTEGER        NOT NULL DEFAULT 15,
    "is_mock"           BOOLEAN        NOT NULL DEFAULT false,
    "snapshot_at"       TIMESTAMPTZ(6) NOT NULL,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "arena_ticker_performance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arena_user_performance_snapshots" (
    "id"                     UUID           NOT NULL DEFAULT gen_random_uuid(),
    "user_id"                UUID           NOT NULL,
    "period"                 TEXT           NOT NULL,
    "period_start"           TIMESTAMPTZ(6) NOT NULL,
    "period_end"             TIMESTAMPTZ(6) NOT NULL,
    "rank"                   INTEGER        NOT NULL,
    "period_starting_equity" DECIMAL        NOT NULL,
    "portfolio_value"        DECIMAL        NOT NULL,
    "period_pnl"             DECIMAL        NOT NULL,
    "return_pct"             DECIMAL        NOT NULL,
    "win_rate_pct"           DECIMAL(5,2),
    "trade_count"            INTEGER        NOT NULL DEFAULT 0,
    "best_ticker"            TEXT,
    "best_trade_return_pct"  DECIMAL,
    "maximum_drawdown_pct"   DECIMAL(5,2),
    "calculated_at"          TIMESTAMPTZ(6) NOT NULL,
    "public_after"           TIMESTAMPTZ(6) NOT NULL,
    "is_mock"                BOOLEAN        NOT NULL DEFAULT false,
    "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "arena_user_performance_snapshots_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "arena_user_performance_snapshots"
    ADD CONSTRAINT "arena_user_performance_snapshots_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- The public ticker read: newest batch for one scope + period.
CREATE INDEX "arena_ticker_perf_scope_idx"
    ON "arena_ticker_performance_snapshots"("scope", "period", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "arena_ticker_perf_symbol_idx"
    ON "arena_ticker_performance_snapshots"("symbol", "period_start" DESC);

-- CreateIndex
-- The public leaderboard read: publishable rows for a period, in rank order.
CREATE INDEX "arena_user_perf_public_idx"
    ON "arena_user_performance_snapshots"("period", "public_after" DESC, "rank");

-- CreateIndex
CREATE INDEX "arena_user_perf_user_idx"
    ON "arena_user_performance_snapshots"("user_id", "period_start" DESC);

-- Row level security, matching every other table in this database.
ALTER TABLE "arena_ticker_performance_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "arena_user_performance_snapshots"   ENABLE ROW LEVEL SECURITY;
