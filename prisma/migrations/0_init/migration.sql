-- 0_init — BASELINE MIGRATION.
--
-- Captures the schema of the pre-existing production database as it stood when
-- the project moved from src/scripts/setupDatabase.ts to Prisma Migrate. It was
-- NEVER executed against that database: it was recorded as already applied with
--   npx prisma migrate resolve --applied 0_init
-- It IS executed in full on a brand-new database (CI, a local dev copy, a
-- restore), so it must reproduce the schema exactly, including the PostgreSQL
-- behaviour Prisma cannot express in schema.prisma (appended at the bottom).

-- Required by every `gen_random_uuid()` column default below.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "anonymized_authors" (
    "author_hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account_age_days" INTEGER,
    "posts_count" INTEGER NOT NULL DEFAULT 0,
    "resolved_signals" INTEGER NOT NULL DEFAULT 0,
    "hit_rate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "reputation_score" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "is_new_account" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "anonymized_authors_pkey" PRIMARY KEY ("author_hash")
);

-- CreateTable
CREATE TABLE "api_usage_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT,
    "route" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "status" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(6),
    "avatar_type" TEXT,
    "avatar_seed" TEXT,
    "google_sub" TEXT,
    "auth_provider" TEXT,

    CONSTRAINT "app_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "event_type" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "author_reputation_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "author_hash" TEXT,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reputation_score" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "hit_rate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "resolved_signals" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "author_reputation_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "author_signal_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "author_hash" TEXT,
    "ticker" TEXT,
    "signal_type" TEXT,
    "stance" TEXT,
    "signaled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "outcome" TEXT,
    "return_pct" DECIMAL,
    "was_early" BOOLEAN,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "author_signal_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "backtest_run_id" UUID,
    "observations" INTEGER,
    "win_rate" DECIMAL,
    "median_return" DECIMAL,
    "average_return" DECIMAL,
    "max_drawdown" DECIMAL,
    "spy_adjusted_return" DECIMAL,
    "option_estimated_return" DECIMAL,
    "result_distribution" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT,
    "query" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_extraction_errors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reddit_post_id" TEXT,
    "reddit_comment_id" TEXT,
    "raw_text" TEXT,
    "error_type" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_extraction_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_legs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bet_id" UUID,
    "leg_type" TEXT,
    "side" TEXT,
    "option_type" TEXT,
    "strike" DECIMAL,
    "expiration_date" DATE,
    "contracts" INTEGER,
    "shares" DECIMAL,
    "premium" DECIMAL,
    "price" DECIMAL,
    "dte" INTEGER,
    "moneyness" TEXT,
    "delta" DECIMAL,
    "theta" DECIMAL,
    "vega" DECIMAL,
    "implied_volatility" DECIMAL,
    "bid" DECIMAL,
    "ask" DECIMAL,
    "mid" DECIMAL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_lifecycle_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bet_id" UUID,
    "event_type" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_performance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bet_id" UUID,
    "ticker" TEXT,
    "realized_return_pct" DECIMAL,
    "peak_return_pct" DECIMAL,
    "trough_return_pct" DECIMAL,
    "outcome" TEXT,
    "spy_adjusted_return" DECIMAL,
    "early_late_score" DECIMAL,
    "resolved_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_performance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bet_id" UUID,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "underlying_price" DECIMAL,
    "estimated_option_value" DECIMAL,
    "estimated_position_value" DECIMAL,
    "return_pct" DECIMAL,
    "unrealized_pl" DECIMAL,
    "max_gain_so_far" DECIMAL,
    "max_loss_so_far" DECIMAL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "bet_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bet_id" UUID,
    "verification_level" TEXT NOT NULL,
    "method" TEXT,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_adjusted_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "signal_ref" TEXT,
    "window_days" INTEGER,
    "raw_return" DECIMAL,
    "spy_return" DECIMAL,
    "beta" DECIMAL,
    "beta_adjusted_return" DECIMAL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beta_adjusted_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_type" TEXT NOT NULL DEFAULT 'reddit',
    "reddit_post_id" TEXT,
    "reddit_comment_id" TEXT,
    "author_hash" TEXT,
    "ticker" TEXT,
    "direction" TEXT,
    "instrument" TEXT,
    "option_type" TEXT,
    "position_intent" TEXT,
    "status" TEXT,
    "declared_capital" DECIMAL,
    "verified_capital" DECIMAL,
    "notional_exposure" DECIMAL,
    "max_loss" DECIMAL,
    "max_gain" DECIMAL,
    "breakeven" DECIMAL,
    "entry_underlying_price" DECIMAL,
    "entry_timestamp" TIMESTAMPTZ(6),
    "extraction_confidence" DECIMAL,
    "verification_level" TEXT,
    "raw_evidence" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalyst_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "catalyst_type" TEXT NOT NULL,
    "title" TEXT,
    "event_date" DATE,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalyst_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_leaderboard_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competition_id" UUID,
    "user_id" UUID NOT NULL,
    "rank" INTEGER,
    "equity_value" DECIMAL,
    "return_pct" DECIMAL,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competition_id" UUID,
    "user_id" UUID NOT NULL,
    "virtual_account_id" UUID,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "starting_cash" DECIMAL DEFAULT 100000,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT,
    "day" DATE NOT NULL,
    "summary" TEXT,
    "highlights" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dd_quality_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reddit_post_id" TEXT,
    "ticker" TEXT,
    "score" DECIMAL,
    "evidence_score" DECIMAL,
    "source_score" DECIMAL,
    "calculation_score" DECIMAL,
    "catalyst_score" DECIMAL,
    "risk_disclosure_score" DECIMAL,
    "originality_score" DECIMAL,
    "category" TEXT,
    "explanation" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dd_quality_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_or_changed_content_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "content_type" TEXT NOT NULL DEFAULT 'post',
    "reddit_post_id" TEXT,
    "reddit_comment_id" TEXT,
    "ticker" TEXT,
    "event_type" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_or_changed_content_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_social_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'stub',
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mentions" INTEGER,
    "sentiment" DECIMAL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "external_social_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insider_activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "insider_role" TEXT,
    "transaction_type" TEXT,
    "shares" DECIMAL,
    "value" DECIMAL,
    "filed_at" TIMESTAMPTZ(6),
    "source" TEXT NOT NULL DEFAULT 'stub',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insider_activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_attention_indexes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL DEFAULT 'global',
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "index_value" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "label" TEXT,
    "components" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_attention_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data_cache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cache_key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_data_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_movers_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DECIMAL,
    "change_pct" DECIMAL,
    "volume" DECIMAL,
    "rank" INTEGER,
    "provider" TEXT,
    "source" TEXT,
    "display_mode" TEXT,
    "delay_minutes" INTEGER,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_movers_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_provider_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_quote_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "symbol" TEXT NOT NULL,
    "price" DECIMAL,
    "change" DECIMAL,
    "change_pct" DECIMAL,
    "volume" DECIMAL,
    "session" TEXT,
    "provider" TEXT,
    "source" TEXT,
    "display_mode" TEXT,
    "delay_minutes" INTEGER,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "is_delayed" BOOLEAN NOT NULL DEFAULT true,
    "observed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_quote_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_quotes_latest" (
    "symbol" TEXT NOT NULL,
    "price" DECIMAL,
    "change" DECIMAL,
    "change_pct" DECIMAL,
    "volume" DECIMAL,
    "session" TEXT,
    "provider" TEXT,
    "source" TEXT,
    "display_mode" TEXT,
    "delay_minutes" INTEGER,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "is_delayed" BOOLEAN NOT NULL DEFAULT true,
    "observed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_quotes_latest_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "market_quotes_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "symbol" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "display_mode" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "price" DECIMAL,
    "bid" DECIMAL,
    "ask" DECIMAL,
    "open" DECIMAL,
    "high" DECIMAL,
    "low" DECIMAL,
    "previous_close" DECIMAL,
    "change" DECIMAL,
    "change_pct" DECIMAL,
    "volume" DECIMAL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_quotes_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT NOT NULL,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DECIMAL,
    "change_pct" DECIMAL,
    "volume" BIGINT,
    "avg_volume" BIGINT,
    "market_cap" DECIMAL,
    "beta" DECIMAL,
    "source" TEXT NOT NULL DEFAULT 'stub',
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "market_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "narrative" TEXT NOT NULL,
    "narrative_type" TEXT,
    "strength" DECIMAL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "narrative_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "from_narrative" TEXT,
    "to_narrative" TEXT,
    "transition_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DECIMAL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "narrative_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "headline" TEXT NOT NULL,
    "url" TEXT,
    "source" TEXT NOT NULL DEFAULT 'stub',
    "sentiment" DECIMAL,
    "published_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_chain_quote_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "underlying" TEXT NOT NULL,
    "option_symbol" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "display_mode" TEXT NOT NULL,
    "expiration" DATE,
    "strike" DECIMAL,
    "type" TEXT,
    "bid" DECIMAL,
    "ask" DECIMAL,
    "last" DECIMAL,
    "mark" DECIMAL,
    "volume" DECIMAL,
    "open_interest" DECIMAL,
    "implied_volatility" DECIMAL,
    "delta" DECIMAL,
    "gamma" DECIMAL,
    "theta" DECIMAL,
    "vega" DECIMAL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_chain_quote_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_chain_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "underlying" TEXT NOT NULL,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiration_date" DATE,
    "source" TEXT NOT NULL DEFAULT 'stub',
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "option_chain_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_contract_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chain_snapshot_id" UUID,
    "underlying" TEXT NOT NULL,
    "option_type" TEXT,
    "strike" DECIMAL,
    "expiration_date" DATE,
    "bid" DECIMAL,
    "ask" DECIMAL,
    "mid" DECIMAL,
    "last" DECIMAL,
    "volume" INTEGER,
    "open_interest" INTEGER,
    "implied_volatility" DECIMAL,
    "delta" DECIMAL,
    "gamma" DECIMAL,
    "theta" DECIMAL,
    "vega" DECIMAL,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_contract_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reddit_post_id" TEXT,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" INTEGER,
    "num_comments" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "post_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pump_coordination_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "bucket_start" TIMESTAMPTZ(6),
    "score" DECIMAL,
    "severity" TEXT,
    "repeated_phrases" JSONB NOT NULL DEFAULT '[]',
    "author_concentration" DECIMAL,
    "new_account_ratio" DECIMAL,
    "cross_subreddit_activity" JSONB NOT NULL DEFAULT '{}',
    "deletion_rate" DECIMAL,
    "explanation" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pump_coordination_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reddit_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "reddit_username" TEXT NOT NULL,
    "reddit_username_normalized" TEXT NOT NULL,
    "reddit_user_id" TEXT,
    "verification_method" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reddit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reddit_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reddit_post_id" TEXT,
    "reddit_comment_id" TEXT,
    "attachment_type" TEXT NOT NULL DEFAULT 'image',
    "url" TEXT,
    "ocr_status" TEXT NOT NULL DEFAULT 'pending',
    "ocr_text" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reddit_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reddit_comments" (
    "reddit_comment_id" TEXT NOT NULL,
    "reddit_post_id" TEXT,
    "subreddit" TEXT NOT NULL,
    "author_hash" TEXT NOT NULL,
    "body_excerpt" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "reddit_created_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reddit_comments_pkey" PRIMARY KEY ("reddit_comment_id")
);

-- CreateTable
CREATE TABLE "reddit_posts" (
    "reddit_post_id" TEXT NOT NULL,
    "subreddit" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body_excerpt" TEXT,
    "author_hash" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "num_comments" INTEGER NOT NULL DEFAULT 0,
    "permalink" TEXT,
    "reddit_created_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reddit_posts_pkey" PRIMARY KEY ("reddit_post_id")
);

-- CreateTable
CREATE TABLE "reddit_verification_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "reddit_username" TEXT NOT NULL,
    "reddit_username_normalized" TEXT NOT NULL,
    "verification_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "admin_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reddit_verification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT,
    "report_type" TEXT,
    "tickers" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateTable
CREATE TABLE "short_interest_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT NOT NULL,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "short_interest" DECIMAL,
    "short_percent_float" DECIMAL,
    "days_to_cover" DECIMAL,
    "borrow_fee" DECIMAL,
    "squeeze_risk_score" DECIMAL,
    "source" TEXT NOT NULL DEFAULT 'stub',
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "short_interest_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "bucket_start" TIMESTAMPTZ(6),
    "signal_type" TEXT NOT NULL,
    "score" DECIMAL,
    "confidence" DECIMAL,
    "explanation" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_id" TEXT NOT NULL,
    "provider" TEXT,
    "source" TEXT,
    "subreddit" TEXT,
    "post_external_id" TEXT,
    "body" TEXT,
    "url" TEXT,
    "author_hash" TEXT,
    "score" INTEGER,
    "tickers" TEXT[],
    "sentiment" TEXT,
    "stance" TEXT,
    "confidence" DECIMAL,
    "posted_at" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_id" TEXT NOT NULL,
    "provider" TEXT,
    "source" TEXT,
    "subreddit" TEXT,
    "type" TEXT,
    "title" TEXT,
    "body" TEXT,
    "url" TEXT,
    "author_hash" TEXT,
    "score" INTEGER,
    "comment_count" INTEGER,
    "tickers" TEXT[],
    "sentiment" TEXT,
    "stance" TEXT,
    "confidence" DECIMAL,
    "is_screenshot" BOOLEAN NOT NULL DEFAULT false,
    "posted_at" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subreddit_pulse_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timeframe" TEXT NOT NULL,
    "subreddit" TEXT NOT NULL,
    "activity_score" DECIMAL,
    "mentions" INTEGER,
    "change_pct" DECIMAL,
    "mood" TEXT,
    "top_tickers" TEXT[],
    "sentiment" TEXT,
    "stance" TEXT,
    "provider" TEXT,
    "source" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "warning" TEXT,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subreddit_pulse_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subreddit_ticker_metrics_1h" (
    "ticker" TEXT NOT NULL,
    "subreddit" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "mentions" INTEGER NOT NULL DEFAULT 0,
    "bullish" INTEGER NOT NULL DEFAULT 0,
    "bearish" INTEGER NOT NULL DEFAULT 0,
    "neutral" INTEGER NOT NULL DEFAULT 0,
    "sentiment_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subreddit_ticker_metrics_1h_pkey" PRIMARY KEY ("ticker","subreddit","bucket_start")
);

-- CreateTable
CREATE TABLE "subreddit_ticker_metrics_5m" (
    "ticker" TEXT NOT NULL,
    "subreddit" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "mentions" INTEGER NOT NULL DEFAULT 0,
    "bullish" INTEGER NOT NULL DEFAULT 0,
    "bearish" INTEGER NOT NULL DEFAULT 0,
    "neutral" INTEGER NOT NULL DEFAULT 0,
    "sentiment_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subreddit_ticker_metrics_5m_pkey" PRIMARY KEY ("ticker","subreddit","bucket_start")
);

-- CreateTable
CREATE TABLE "ticker_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "explanation" TEXT,
    "metrics_snapshot" JSONB NOT NULL DEFAULT '{}',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticker_daily_metrics" (
    "ticker" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "mentions" INTEGER NOT NULL DEFAULT 0,
    "unique_authors" INTEGER NOT NULL DEFAULT 0,
    "bullish" INTEGER NOT NULL DEFAULT 0,
    "bearish" INTEGER NOT NULL DEFAULT 0,
    "neutral" INTEGER NOT NULL DEFAULT 0,
    "sentiment_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "mention_share" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_daily_metrics_pkey" PRIMARY KEY ("ticker","day")
);

-- CreateTable
CREATE TABLE "ticker_mentions" (
    "id" BIGSERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "reddit_post_id" TEXT NOT NULL,
    "pump_language_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "narrative_type" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticker_metrics_5m" (
    "ticker" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "mentions" INTEGER NOT NULL DEFAULT 0,
    "posts_count" INTEGER NOT NULL DEFAULT 0,
    "unique_authors" INTEGER NOT NULL DEFAULT 0,
    "avg_score" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_comments" INTEGER NOT NULL DEFAULT 0,
    "mention_velocity" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "abnormality_score" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sentiment_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "pump_language_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_metrics_5m_pkey" PRIMARY KEY ("ticker","bucket_start")
);

-- CreateTable
CREATE TABLE "ticker_positioning_indexes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT,
    "bucket_start" TIMESTAMPTZ(6),
    "call_conviction" DECIMAL,
    "put_conviction" DECIMAL,
    "net_directional_conviction" DECIMAL,
    "declared_yolo_capital" DECIMAL,
    "verified_yolo_capital" DECIMAL,
    "average_dte" DECIMAL,
    "average_moneyness" DECIMAL,
    "premium_at_risk" DECIMAL,
    "leveraged_sentiment" DECIMAL,
    "expiration_wall" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_positioning_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticker_stance_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT NOT NULL,
    "reddit_post_id" TEXT,
    "reddit_comment_id" TEXT,
    "author_hash" TEXT,
    "subreddit" TEXT,
    "stance" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "matched_terms" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_stance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticker_trend_classifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticker" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "classification" TEXT NOT NULL,
    "score" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_trend_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickers" (
    "ticker" TEXT NOT NULL,
    "company_name" TEXT,
    "exchange" TEXT,
    "is_active" BOOLEAN DEFAULT true,
    "is_common_word" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickers_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "trending_ticker_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timeframe" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "mention_count" INTEGER,
    "sentiment" TEXT,
    "stance" TEXT,
    "price" DECIMAL,
    "change_pct" DECIMAL,
    "provider_social" TEXT,
    "provider_market" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trending_ticker_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_alert_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "alert_rule_id" UUID,
    "user_id" TEXT,
    "ticker" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "delivered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_alert_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "name" TEXT,
    "rule_type" TEXT NOT NULL,
    "ticker" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alert_type" TEXT,
    "condition" JSONB NOT NULL DEFAULT '{}',
    "delivery_channels" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "user_alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_portfolio_positions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "quantity" DECIMAL,
    "avg_cost" DECIMAL,
    "instrument" TEXT NOT NULL DEFAULT 'stock',
    "opened_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_portfolio_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "session_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_watchlist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "watchlist_id" UUID,
    "ticker" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_watchlists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Watchlist',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "reddit_id" TEXT NOT NULL,
    "reddit_username" TEXT NOT NULL,
    "reddit_avatar_url" TEXT,
    "reddit_created_at" TIMESTAMPTZ(6),
    "reddit_has_verified_email" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "starting_cash" DECIMAL NOT NULL DEFAULT 100000,
    "cash_balance" DECIMAL NOT NULL DEFAULT 100000,
    "equity_value" DECIMAL NOT NULL DEFAULT 100000,
    "currency" TEXT DEFAULT 'USD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtual_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_positions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "virtual_account_id" UUID,
    "ticker" TEXT,
    "instrument" TEXT,
    "option_type" TEXT,
    "strike" DECIMAL,
    "expiration_date" DATE,
    "quantity" DECIMAL NOT NULL,
    "avg_cost" DECIMAL NOT NULL,
    "market_value" DECIMAL DEFAULT 0,
    "unrealized_pl" DECIMAL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtual_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_trades" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "virtual_account_id" UUID,
    "ticker" TEXT,
    "side" TEXT,
    "instrument" TEXT,
    "option_type" TEXT,
    "strike" DECIMAL,
    "expiration_date" DATE,
    "quantity" DECIMAL NOT NULL,
    "price" DECIMAL NOT NULL,
    "notional_value" DECIMAL NOT NULL,
    "fees" DECIMAL DEFAULT 0,
    "status" TEXT DEFAULT 'filled',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtual_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "event_types" JSONB NOT NULL DEFAULT '[]',
    "secret" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_name" TEXT,
    "job_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_users_email_key" ON "app_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "app_users_email_normalized_key" ON "app_users"("email_normalized");

-- CreateIndex
CREATE INDEX "app_users_email_normalized_idx" ON "app_users"("email_normalized");

-- CreateIndex
CREATE INDEX "auth_events_user_idx" ON "auth_events"("user_id");

-- CreateIndex
CREATE INDEX "author_signal_hist_author_idx" ON "author_signal_history"("author_hash");

-- CreateIndex
CREATE INDEX "bet_legs_bet_idx" ON "bet_legs"("bet_id");

-- CreateIndex
CREATE INDEX "bet_legs_expiration_idx" ON "bet_legs"("expiration_date");

-- CreateIndex
CREATE INDEX "bet_performance_bet_idx" ON "bet_performance"("bet_id");

-- CreateIndex
CREATE INDEX "bet_snapshots_bet_idx" ON "bet_snapshots"("bet_id");

-- CreateIndex
CREATE INDEX "bets_author_idx" ON "bets"("author_hash");

-- CreateIndex
CREATE INDEX "bets_created_idx" ON "bets"("created_at");

-- CreateIndex
CREATE INDEX "bets_post_idx" ON "bets"("reddit_post_id");

-- CreateIndex
CREATE INDEX "bets_ticker_idx" ON "bets"("ticker");

-- CreateIndex
CREATE INDEX "competition_leaderboard_comp_idx" ON "competition_leaderboard_snapshots"("competition_id");

-- CreateIndex
CREATE INDEX "competition_participants_comp_idx" ON "competition_participants"("competition_id");

-- CreateIndex
CREATE UNIQUE INDEX "competition_participants_uniq" ON "competition_participants"("competition_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_summaries_uniq" ON "daily_summaries"("user_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "dd_quality_scores_uniq" ON "dd_quality_scores"("reddit_post_id");

-- CreateIndex
CREATE INDEX "dd_scores_ticker_idx" ON "dd_quality_scores"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_hash_idx" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "market_attention_indexes_uniq" ON "market_attention_indexes"("scope", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "market_data_cache_cache_key_key" ON "market_data_cache"("cache_key");

-- CreateIndex
CREATE INDEX "market_data_cache_key_idx" ON "market_data_cache"("cache_key");

-- CreateIndex
CREATE INDEX "market_movers_snapshots_session_idx" ON "market_movers_snapshots"("session", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "market_provider_events_provider_idx" ON "market_provider_events"("provider", "created_at" DESC);

-- CreateIndex
CREATE INDEX "market_quote_snapshots_symbol_idx" ON "market_quote_snapshots"("symbol", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "market_quotes_snapshots_symbol_idx" ON "market_quotes_snapshots"("symbol", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "market_snapshots_at_idx" ON "market_snapshots"("snapshot_at");

-- CreateIndex
CREATE INDEX "market_snapshots_ticker_idx" ON "market_snapshots"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "market_snapshots_uniq" ON "market_snapshots"("ticker", "snapshot_at");

-- CreateIndex
CREATE INDEX "narrative_events_ticker_idx" ON "narrative_events"("ticker");

-- CreateIndex
CREATE INDEX "news_events_ticker_idx" ON "news_events"("ticker");

-- CreateIndex
CREATE INDEX "option_chain_quote_snapshots_key_idx" ON "option_chain_quote_snapshots"("underlying", "expiration", "strike", "type");

-- CreateIndex
CREATE INDEX "option_chain_snapshots_underlying_idx" ON "option_chain_snapshots"("underlying", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "option_contract_underlying_idx" ON "option_contract_snapshots"("underlying");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_hash_idx" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "pump_scores_ticker_idx" ON "pump_coordination_scores"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "pump_coordination_scores_uniq" ON "pump_coordination_scores"("ticker", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "reddit_accounts_reddit_username_normalized_key" ON "reddit_accounts"("reddit_username_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "reddit_accounts_reddit_user_id_key" ON "reddit_accounts"("reddit_user_id");

-- CreateIndex
CREATE INDEX "reddit_accounts_user_idx" ON "reddit_accounts"("user_id");

-- CreateIndex
CREATE INDEX "reddit_accounts_username_norm_idx" ON "reddit_accounts"("reddit_username_normalized");

-- CreateIndex
CREATE INDEX "reddit_comments_author_idx" ON "reddit_comments"("author_hash");

-- CreateIndex
CREATE INDEX "reddit_comments_post_idx" ON "reddit_comments"("reddit_post_id");

-- CreateIndex
CREATE INDEX "reddit_verif_requests_code_idx" ON "reddit_verification_requests"("verification_code");

-- CreateIndex
CREATE INDEX "reddit_verif_requests_status_idx" ON "reddit_verification_requests"("status");

-- CreateIndex
CREATE INDEX "reddit_verif_requests_user_idx" ON "reddit_verification_requests"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_reports_slug_key" ON "research_reports"("slug");

-- CreateIndex
CREATE INDEX "IDX_session_expire" ON "session"("expire");

-- CreateIndex
CREATE INDEX "signal_scores_ticker_idx" ON "signal_scores"("ticker");

-- CreateIndex
CREATE INDEX "signal_scores_type_idx" ON "signal_scores"("signal_type");

-- CreateIndex
CREATE UNIQUE INDEX "signal_scores_uniq" ON "signal_scores"("ticker", "bucket_start", "signal_type");

-- CreateIndex
CREATE UNIQUE INDEX "social_comments_external_id_key" ON "social_comments"("external_id");

-- CreateIndex
CREATE INDEX "social_comments_subreddit_idx" ON "social_comments"("subreddit", "posted_at" DESC);

-- CreateIndex
CREATE INDEX "social_comments_tickers_gin" ON "social_comments" USING GIN ("tickers");

-- CreateIndex
CREATE UNIQUE INDEX "social_posts_external_id_key" ON "social_posts"("external_id");

-- CreateIndex
CREATE INDEX "social_posts_posted_idx" ON "social_posts"("posted_at" DESC);

-- CreateIndex
CREATE INDEX "social_posts_subreddit_idx" ON "social_posts"("subreddit", "posted_at" DESC);

-- CreateIndex
CREATE INDEX "social_posts_tickers_gin" ON "social_posts" USING GIN ("tickers");

-- CreateIndex
CREATE INDEX "subreddit_pulse_snapshots_tf_idx" ON "subreddit_pulse_snapshots"("timeframe", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "sub_metrics_5m_sub_idx" ON "subreddit_ticker_metrics_5m"("subreddit");

-- CreateIndex
CREATE INDEX "ticker_alerts_created_idx" ON "ticker_alerts"("created_at");

-- CreateIndex
CREATE INDEX "ticker_alerts_ticker_idx" ON "ticker_alerts"("ticker");

-- CreateIndex
CREATE INDEX "ticker_daily_metrics_day_idx" ON "ticker_daily_metrics"("day");

-- CreateIndex
CREATE INDEX "ticker_mentions_created_idx" ON "ticker_mentions"("created_at");

-- CreateIndex
CREATE INDEX "ticker_mentions_ticker_idx" ON "ticker_mentions"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "ticker_mentions_ticker_post_uniq" ON "ticker_mentions"("ticker", "reddit_post_id");

-- CreateIndex
CREATE INDEX "ticker_metrics_5m_bucket_idx" ON "ticker_metrics_5m"("bucket_start");

-- CreateIndex
CREATE INDEX "positioning_ticker_idx" ON "ticker_positioning_indexes"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "ticker_positioning_indexes_uniq" ON "ticker_positioning_indexes"("ticker", "bucket_start");

-- CreateIndex
CREATE INDEX "stance_events_created_idx" ON "ticker_stance_events"("created_at");

-- CreateIndex
CREATE INDEX "stance_events_ticker_idx" ON "ticker_stance_events"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "ticker_trend_class_uniq" ON "ticker_trend_classifications"("ticker", "bucket_start", "classification");

-- CreateIndex
CREATE INDEX "trending_ticker_snapshots_symbol_idx" ON "trending_ticker_snapshots"("symbol", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "trending_ticker_snapshots_tf_idx" ON "trending_ticker_snapshots"("timeframe", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "user_notifications_user_idx" ON "user_notifications"("user_id");

-- CreateIndex
CREATE INDEX "portfolio_user_idx" ON "user_portfolio_positions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_session_token_hash_key" ON "user_sessions"("session_token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_token_hash_idx" ON "user_sessions"("session_token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "watchlist_items_ticker_idx" ON "user_watchlist_items"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "user_watchlist_items_uniq" ON "user_watchlist_items"("watchlist_id", "ticker");

-- CreateIndex
CREATE UNIQUE INDEX "user_watchlists_uniq" ON "user_watchlists"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "users_reddit_id_key" ON "users"("reddit_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_accounts_user_uniq" ON "virtual_accounts"("user_id");

-- CreateIndex
CREATE INDEX "virtual_accounts_user_idx" ON "virtual_accounts"("user_id");

-- CreateIndex
CREATE INDEX "virtual_positions_account_idx" ON "virtual_positions"("virtual_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_positions_uniq" ON "virtual_positions"("virtual_account_id", "ticker", "instrument", "option_type", "strike", "expiration_date");

-- CreateIndex
CREATE INDEX "virtual_trades_account_idx" ON "virtual_trades"("virtual_account_id");

-- CreateIndex
CREATE INDEX "virtual_trades_user_idx" ON "virtual_trades"("user_id");

-- CreateIndex
CREATE INDEX "worker_runs_job_idx" ON "worker_runs"("job_name", "created_at" DESC);

-- CreateIndex
CREATE INDEX "worker_runs_status_idx" ON "worker_runs"("status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "author_reputation_snapshots" ADD CONSTRAINT "author_reputation_snapshots_author_hash_fkey" FOREIGN KEY ("author_hash") REFERENCES "anonymized_authors"("author_hash") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "author_signal_history" ADD CONSTRAINT "author_signal_history_author_hash_fkey" FOREIGN KEY ("author_hash") REFERENCES "anonymized_authors"("author_hash") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_backtest_run_id_fkey" FOREIGN KEY ("backtest_run_id") REFERENCES "backtest_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bet_legs" ADD CONSTRAINT "bet_legs_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bet_lifecycle_events" ADD CONSTRAINT "bet_lifecycle_events_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bet_performance" ADD CONSTRAINT "bet_performance_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bet_snapshots" ADD CONSTRAINT "bet_snapshots_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bet_verifications" ADD CONSTRAINT "bet_verifications_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "beta_adjusted_results" ADD CONSTRAINT "beta_adjusted_results_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_reddit_post_id_fkey" FOREIGN KEY ("reddit_post_id") REFERENCES "reddit_posts"("reddit_post_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_leaderboard_snapshots" ADD CONSTRAINT "competition_leaderboard_snapshots_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_leaderboard_snapshots" ADD CONSTRAINT "competition_leaderboard_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_virtual_account_id_fkey" FOREIGN KEY ("virtual_account_id") REFERENCES "virtual_accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dd_quality_scores" ADD CONSTRAINT "dd_quality_scores_reddit_post_id_fkey" FOREIGN KEY ("reddit_post_id") REFERENCES "reddit_posts"("reddit_post_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dd_quality_scores" ADD CONSTRAINT "dd_quality_scores_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "narrative_events" ADD CONSTRAINT "narrative_events_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "narrative_transitions" ADD CONSTRAINT "narrative_transitions_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "option_contract_snapshots" ADD CONSTRAINT "option_contract_snapshots_chain_snapshot_id_fkey" FOREIGN KEY ("chain_snapshot_id") REFERENCES "option_chain_snapshots"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "post_snapshots" ADD CONSTRAINT "post_snapshots_reddit_post_id_fkey" FOREIGN KEY ("reddit_post_id") REFERENCES "reddit_posts"("reddit_post_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pump_coordination_scores" ADD CONSTRAINT "pump_coordination_scores_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reddit_accounts" ADD CONSTRAINT "reddit_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reddit_attachments" ADD CONSTRAINT "reddit_attachments_reddit_post_id_fkey" FOREIGN KEY ("reddit_post_id") REFERENCES "reddit_posts"("reddit_post_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reddit_comments" ADD CONSTRAINT "reddit_comments_reddit_post_id_fkey" FOREIGN KEY ("reddit_post_id") REFERENCES "reddit_posts"("reddit_post_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reddit_verification_requests" ADD CONSTRAINT "reddit_verification_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signal_scores" ADD CONSTRAINT "signal_scores_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subreddit_ticker_metrics_1h" ADD CONSTRAINT "subreddit_ticker_metrics_1h_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subreddit_ticker_metrics_5m" ADD CONSTRAINT "subreddit_ticker_metrics_5m_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_alerts" ADD CONSTRAINT "ticker_alerts_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_daily_metrics" ADD CONSTRAINT "ticker_daily_metrics_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_mentions" ADD CONSTRAINT "ticker_mentions_reddit_post_id_fkey" FOREIGN KEY ("reddit_post_id") REFERENCES "reddit_posts"("reddit_post_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_mentions" ADD CONSTRAINT "ticker_mentions_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_metrics_5m" ADD CONSTRAINT "ticker_metrics_5m_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_positioning_indexes" ADD CONSTRAINT "ticker_positioning_indexes_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_stance_events" ADD CONSTRAINT "ticker_stance_events_reddit_post_id_fkey" FOREIGN KEY ("reddit_post_id") REFERENCES "reddit_posts"("reddit_post_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_stance_events" ADD CONSTRAINT "ticker_stance_events_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticker_trend_classifications" ADD CONSTRAINT "ticker_trend_classifications_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_alert_deliveries" ADD CONSTRAINT "user_alert_deliveries_alert_rule_id_fkey" FOREIGN KEY ("alert_rule_id") REFERENCES "user_alert_rules"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_watchlist_items" ADD CONSTRAINT "user_watchlist_items_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "user_watchlists"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_accounts" ADD CONSTRAINT "virtual_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_positions" ADD CONSTRAINT "virtual_positions_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_positions" ADD CONSTRAINT "virtual_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_positions" ADD CONSTRAINT "virtual_positions_virtual_account_id_fkey" FOREIGN KEY ("virtual_account_id") REFERENCES "virtual_accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_trades" ADD CONSTRAINT "virtual_trades_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "tickers"("ticker") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_trades" ADD CONSTRAINT "virtual_trades_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "virtual_trades" ADD CONSTRAINT "virtual_trades_virtual_account_id_fkey" FOREIGN KEY ("virtual_account_id") REFERENCES "virtual_accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ═══════════════════════════════════════════════════════════════════════════
-- PostgreSQL behaviour Prisma cannot express in schema.prisma.
--
-- Prisma Migrate does not generate any of the following, so it is maintained by
-- hand here. Keep it in sync when the underlying columns change.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── CHECK constraints ──────────────────────────────────────────────────────
-- Prisma has no check-constraint support, so these enumerations are enforced by
-- the database only. Application code must keep its literals in step.
ALTER TABLE "bet_legs" ADD CONSTRAINT "bet_legs_leg_type_check" CHECK (leg_type = ANY (ARRAY['stock'::text, 'option'::text]));
ALTER TABLE "bet_legs" ADD CONSTRAINT "bet_legs_moneyness_check" CHECK (moneyness = ANY (ARRAY['ITM'::text, 'ATM'::text, 'OTM'::text, 'unknown'::text]));
ALTER TABLE "bet_legs" ADD CONSTRAINT "bet_legs_option_type_check" CHECK (option_type = ANY (ARRAY['call'::text, 'put'::text]));
ALTER TABLE "bet_legs" ADD CONSTRAINT "bet_legs_side_check" CHECK (side = ANY (ARRAY['long'::text, 'short'::text]));
ALTER TABLE "bets" ADD CONSTRAINT "bets_direction_check" CHECK (direction = ANY (ARRAY['bullish'::text, 'bearish'::text, 'neutral'::text, 'unknown'::text]));
ALTER TABLE "bets" ADD CONSTRAINT "bets_instrument_check" CHECK (instrument = ANY (ARRAY['stock'::text, 'option'::text, 'spread'::text, 'unknown'::text]));
ALTER TABLE "bets" ADD CONSTRAINT "bets_option_type_check" CHECK (option_type = ANY (ARRAY['call'::text, 'put'::text]));
ALTER TABLE "bets" ADD CONSTRAINT "bets_position_intent_check" CHECK (position_intent = ANY (ARRAY['real_position'::text, 'pending_order'::text, 'future_intent'::text, 'question'::text, 'hypothesis'::text, 'recommendation'::text, 'sarcasm'::text, 'meme'::text, 'closed_position'::text, 'unverified'::text]));
ALTER TABLE "bets" ADD CONSTRAINT "bets_status_check" CHECK (status = ANY (ARRAY['open'::text, 'closed'::text, 'expired'::text, 'assigned'::text, 'rolled'::text, 'unknown'::text]));
ALTER TABLE "bets" ADD CONSTRAINT "bets_verification_level_check" CHECK (verification_level = ANY (ARRAY['text_only'::text, 'screenshot_detected'::text, 'internally_consistent'::text, 'market_validated'::text, 'follow_up_verified'::text, 'unverified'::text]));
ALTER TABLE "option_contract_snapshots" ADD CONSTRAINT "option_contract_snapshots_option_type_check" CHECK (option_type = ANY (ARRAY['call'::text, 'put'::text]));
ALTER TABLE "reddit_accounts" ADD CONSTRAINT "reddit_accounts_verification_method_check" CHECK (verification_method = ANY (ARRAY['oauth'::text, 'inbound_dm_manual'::text, 'inbound_dm_automated'::text]));
ALTER TABLE "reddit_accounts" ADD CONSTRAINT "reddit_accounts_verification_status_check" CHECK (verification_status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'expired'::text]));
ALTER TABLE "reddit_verification_requests" ADD CONSTRAINT "reddit_verification_requests_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'user_claimed_sent'::text, 'verified'::text, 'rejected'::text, 'expired'::text]));
ALTER TABLE "ticker_stance_events" ADD CONSTRAINT "ticker_stance_events_stance_check" CHECK (stance = ANY (ARRAY['bullish'::text, 'bearish'::text, 'neutral'::text, 'unknown'::text]));
ALTER TABLE "virtual_trades" ADD CONSTRAINT "virtual_trades_instrument_check" CHECK (instrument = ANY (ARRAY['stock'::text, 'option'::text]));
ALTER TABLE "virtual_trades" ADD CONSTRAINT "virtual_trades_option_type_check" CHECK (option_type = ANY (ARRAY['call'::text, 'put'::text]));
ALTER TABLE "virtual_trades" ADD CONSTRAINT "virtual_trades_side_check" CHECK (side = ANY (ARRAY['buy'::text, 'sell'::text, 'short'::text, 'cover'::text]));

-- ── Partial unique index ───────────────────────────────────────────────────
-- Prisma cannot express a WHERE clause on an index. A user has at most one
-- linked Google account, but most users have none, so the many NULLs must be
-- excluded rather than treated as duplicates.
CREATE UNIQUE INDEX "app_users_google_sub_uniq" ON "app_users" USING btree (google_sub) WHERE (google_sub IS NOT NULL);

-- ── Row Level Security ─────────────────────────────────────────────────────
-- Prisma does not manage RLS. bwsb connects with the service role, which
-- bypasses RLS; the frontend never connects to the database directly. With RLS
-- on and NO permissive policies, anon/authenticated Supabase clients get zero
-- rows — every read must go through the backend API. Applied by loop so that
-- tables added by later migrations are covered when this runs on a fresh
-- database; later migrations must enable RLS on the tables they create.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
