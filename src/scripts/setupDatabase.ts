/**
 * setupDatabase.ts
 *
 * Creates the full database schema for bwsb (backend for YOLOPulse, internal
 * project "wsb"). Idempotent — every statement uses IF NOT EXISTS so it is safe
 * to run repeatedly.
 *
 * SERVER-SIDE ONLY. Reads DATABASE_URL from the environment and connects with
 * the pg driver. DATABASE_URL is never exposed to the frontend and is never
 * logged in full.
 *
 * Usage:
 *   npm run db:setup
 *
 * This does NOT run automatically when the server starts.
 */
import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

/** Read and validate DATABASE_URL without ever logging its value. */
function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url || url.trim() === "") {
    console.error(
      "❌ DATABASE_URL is not set. Add it to bwsb/.env before running this script.",
    );
    process.exit(1);
  }

  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error(
      "❌ DATABASE_URL must start with postgresql:// or postgres://",
    );
    process.exit(1);
  }

  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema. Grouped to mirror the product areas. UUID PKs via gen_random_uuid(),
// timestamptz everywhere, jsonb for flexible snapshots.
// ─────────────────────────────────────────────────────────────────────────────
const SCHEMA_SQL = /* sql */ `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ══ Auth / users (identity from Reddit OAuth) ═══════════════════════════════
CREATE TABLE IF NOT EXISTS public.users (
  id                        text PRIMARY KEY,
  reddit_id                 text NOT NULL UNIQUE,
  reddit_username           text NOT NULL,
  reddit_avatar_url         text,
  reddit_created_at         timestamptz,
  reddit_has_verified_email boolean NOT NULL DEFAULT false,
  email                     text UNIQUE,
  email_verified            boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ══ Email/password auth (PRIMARY identity) ══════════════════════════════════
-- app_users is the primary account record for email + password auth. This is
-- separate from public.users (legacy Reddit-OAuth identity), which is retained
-- for the optional/future Reddit OAuth flow.
CREATE TABLE IF NOT EXISTS public.app_users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text UNIQUE NOT NULL,
  email_normalized  text UNIQUE NOT NULL,
  email_verified_at timestamptz,
  password_hash     text,
  display_name      text,
  avatar_url        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

-- Opaque session tokens (sha256-hashed). The raw token lives only in the
-- httpOnly yt_session cookie and is never stored.
CREATE TABLE IF NOT EXISTS public.user_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  session_token_hash text UNIQUE NOT NULL,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One-time email verification / set-password tokens (sha256-hashed).
CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One-time password reset tokens (sha256-hashed).
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Verified Reddit accounts linked to an app_user (badge / credibility only).
CREATE TABLE IF NOT EXISTS public.reddit_accounts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  reddit_username            text NOT NULL,
  reddit_username_normalized text UNIQUE NOT NULL,
  reddit_user_id             text UNIQUE,
  verification_method        text NOT NULL CHECK (verification_method IN ('oauth','inbound_dm_manual','inbound_dm_automated')),
  verification_status        text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected','expired')),
  verified_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Inbound Reddit verification requests: user sends a code to u/<verify account>.
CREATE TABLE IF NOT EXISTS public.reddit_verification_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  reddit_username            text NOT NULL,
  reddit_username_normalized text NOT NULL,
  verification_code          text NOT NULL,
  status                     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','user_claimed_sent','verified','rejected','expired')),
  expires_at                 timestamptz NOT NULL,
  verified_at                timestamptz,
  rejected_at                timestamptz,
  admin_notes                text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Audit trail for auth events (login, signup, reset, reddit verification, …).
CREATE TABLE IF NOT EXISTS public.auth_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  event_type    text NOT NULL,
  success       boolean NOT NULL,
  ip_address    text,
  user_agent    text,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ══ Reference / existing tables ═════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.tickers (
  ticker         text PRIMARY KEY,
  company_name   text,
  exchange       text,
  is_active      boolean DEFAULT true,
  is_common_word boolean DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reddit_posts (
  reddit_post_id    text PRIMARY KEY,
  subreddit         text NOT NULL,
  title             text NOT NULL,
  body_excerpt      text,
  author_hash       text NOT NULL,
  score             integer NOT NULL DEFAULT 0,
  num_comments      integer NOT NULL DEFAULT 0,
  permalink         text,
  reddit_created_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ticker_mentions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker              text NOT NULL REFERENCES public.tickers(ticker),
  reddit_post_id      text NOT NULL REFERENCES public.reddit_posts(reddit_post_id),
  pump_language_score numeric(5, 4) NOT NULL DEFAULT 0,
  narrative_type      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticker_mentions_ticker_post_uniq UNIQUE (ticker, reddit_post_id)
);

CREATE TABLE IF NOT EXISTS public.ticker_metrics_5m (
  ticker              text NOT NULL REFERENCES public.tickers(ticker),
  bucket_start        timestamptz NOT NULL,
  mentions            integer NOT NULL DEFAULT 0,
  posts_count         integer NOT NULL DEFAULT 0,
  unique_authors      integer NOT NULL DEFAULT 0,
  avg_score           numeric(10, 2) NOT NULL DEFAULT 0,
  total_comments      integer NOT NULL DEFAULT 0,
  mention_velocity    numeric(10, 2) NOT NULL DEFAULT 0,
  abnormality_score   numeric(10, 2) NOT NULL DEFAULT 0,
  sentiment_score     numeric(5, 4) NOT NULL DEFAULT 0,
  pump_language_score numeric(5, 4) NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticker_metrics_5m_pkey PRIMARY KEY (ticker, bucket_start)
);

CREATE TABLE IF NOT EXISTS public.ticker_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker           text NOT NULL REFERENCES public.tickers(ticker),
  alert_type       text NOT NULL,
  severity         text NOT NULL,
  explanation      text,
  metrics_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ══ A. Raw / content ════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.reddit_comments (
  reddit_comment_id text PRIMARY KEY,
  reddit_post_id    text REFERENCES public.reddit_posts(reddit_post_id) ON DELETE CASCADE,
  subreddit         text NOT NULL,
  author_hash       text NOT NULL,
  body_excerpt      text,
  score             integer NOT NULL DEFAULT 0,
  reddit_created_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reddit_attachments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reddit_post_id    text REFERENCES public.reddit_posts(reddit_post_id) ON DELETE CASCADE,
  reddit_comment_id text,
  attachment_type   text NOT NULL DEFAULT 'image',
  url               text,
  ocr_status        text NOT NULL DEFAULT 'pending',
  ocr_text          text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.post_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reddit_post_id text REFERENCES public.reddit_posts(reddit_post_id) ON DELETE CASCADE,
  snapshot_at    timestamptz NOT NULL DEFAULT now(),
  score          integer,
  num_comments   integer,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.deleted_or_changed_content_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type   text NOT NULL DEFAULT 'post',
  reddit_post_id text,
  reddit_comment_id text,
  ticker         text,
  event_type     text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at    timestamptz NOT NULL DEFAULT now()
);

-- ══ B. Mention / sentiment ══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.ticker_stance_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker         text NOT NULL REFERENCES public.tickers(ticker),
  reddit_post_id text REFERENCES public.reddit_posts(reddit_post_id) ON DELETE SET NULL,
  reddit_comment_id text,
  author_hash    text,
  subreddit      text,
  stance         text NOT NULL CHECK (stance IN ('bullish','bearish','neutral','unknown')),
  confidence     numeric(5,4) NOT NULL DEFAULT 0,
  matched_terms  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subreddit_ticker_metrics_5m (
  ticker           text NOT NULL REFERENCES public.tickers(ticker),
  subreddit        text NOT NULL,
  bucket_start     timestamptz NOT NULL,
  mentions         integer NOT NULL DEFAULT 0,
  bullish          integer NOT NULL DEFAULT 0,
  bearish          integer NOT NULL DEFAULT 0,
  neutral          integer NOT NULL DEFAULT 0,
  sentiment_score  numeric(5,4) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subreddit_ticker_metrics_5m_pkey PRIMARY KEY (ticker, subreddit, bucket_start)
);

CREATE TABLE IF NOT EXISTS public.subreddit_ticker_metrics_1h (
  ticker           text NOT NULL REFERENCES public.tickers(ticker),
  subreddit        text NOT NULL,
  bucket_start     timestamptz NOT NULL,
  mentions         integer NOT NULL DEFAULT 0,
  bullish          integer NOT NULL DEFAULT 0,
  bearish          integer NOT NULL DEFAULT 0,
  neutral          integer NOT NULL DEFAULT 0,
  sentiment_score  numeric(5,4) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subreddit_ticker_metrics_1h_pkey PRIMARY KEY (ticker, subreddit, bucket_start)
);

CREATE TABLE IF NOT EXISTS public.ticker_daily_metrics (
  ticker           text NOT NULL REFERENCES public.tickers(ticker),
  day              date NOT NULL,
  mentions         integer NOT NULL DEFAULT 0,
  unique_authors   integer NOT NULL DEFAULT 0,
  bullish          integer NOT NULL DEFAULT 0,
  bearish          integer NOT NULL DEFAULT 0,
  neutral          integer NOT NULL DEFAULT 0,
  sentiment_score  numeric(5,4) NOT NULL DEFAULT 0,
  mention_share    numeric(5,4) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticker_daily_metrics_pkey PRIMARY KEY (ticker, day)
);

CREATE TABLE IF NOT EXISTS public.ticker_trend_classifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker         text NOT NULL REFERENCES public.tickers(ticker),
  bucket_start   timestamptz NOT NULL,
  classification text NOT NULL,
  score          numeric(10,4) NOT NULL DEFAULT 0,
  rank           integer,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticker_trend_class_uniq UNIQUE (ticker, bucket_start, classification)
);

CREATE TABLE IF NOT EXISTS public.market_attention_indexes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          text NOT NULL DEFAULT 'global',
  bucket_start   timestamptz NOT NULL,
  index_value    numeric(6,2) NOT NULL DEFAULT 0,
  label          text,
  components      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_attention_indexes_uniq UNIQUE (scope, bucket_start)
);

-- ══ C. Bet intelligence ═════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.bets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type           text NOT NULL DEFAULT 'reddit',
  reddit_post_id        text REFERENCES public.reddit_posts(reddit_post_id) ON DELETE SET NULL,
  reddit_comment_id     text,
  author_hash           text,
  ticker                text REFERENCES public.tickers(ticker),
  direction             text CHECK (direction IN ('bullish','bearish','neutral','unknown')),
  instrument            text CHECK (instrument IN ('stock','option','spread','unknown')),
  option_type           text CHECK (option_type IN ('call','put')),
  position_intent       text CHECK (position_intent IN ('real_position','pending_order','future_intent','question','hypothesis','recommendation','sarcasm','meme','closed_position','unverified')),
  status                text CHECK (status IN ('open','closed','expired','assigned','rolled','unknown')),
  declared_capital      numeric,
  verified_capital      numeric,
  notional_exposure     numeric,
  max_loss              numeric,
  max_gain              numeric,
  breakeven             numeric,
  entry_underlying_price numeric,
  entry_timestamp       timestamptz,
  extraction_confidence numeric,
  verification_level    text CHECK (verification_level IN ('text_only','screenshot_detected','internally_consistent','market_validated','follow_up_verified','unverified')),
  raw_evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bet_legs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id             uuid REFERENCES public.bets(id) ON DELETE CASCADE,
  leg_type           text CHECK (leg_type IN ('stock','option')),
  side               text CHECK (side IN ('long','short')),
  option_type        text CHECK (option_type IN ('call','put')),
  strike             numeric,
  expiration_date    date,
  contracts          integer,
  shares             numeric,
  premium            numeric,
  price              numeric,
  dte                integer,
  moneyness          text CHECK (moneyness IN ('ITM','ATM','OTM','unknown')),
  delta              numeric,
  theta              numeric,
  vega               numeric,
  implied_volatility numeric,
  bid                numeric,
  ask                numeric,
  mid                numeric,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bet_snapshots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id                  uuid REFERENCES public.bets(id) ON DELETE CASCADE,
  snapshot_at             timestamptz NOT NULL DEFAULT now(),
  underlying_price        numeric,
  estimated_option_value  numeric,
  estimated_position_value numeric,
  return_pct              numeric,
  unrealized_pl           numeric,
  max_gain_so_far         numeric,
  max_loss_so_far         numeric,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.bet_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id             uuid REFERENCES public.bets(id) ON DELETE CASCADE,
  verification_level text NOT NULL,
  method             text,
  passed             boolean NOT NULL DEFAULT false,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bet_lifecycle_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id      uuid REFERENCES public.bets(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bet_performance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id              uuid REFERENCES public.bets(id) ON DELETE CASCADE,
  ticker              text,
  realized_return_pct numeric,
  peak_return_pct     numeric,
  trough_return_pct   numeric,
  outcome             text,
  spy_adjusted_return numeric,
  early_late_score    numeric,
  resolved_at         timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bet_extraction_errors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reddit_post_id text,
  reddit_comment_id text,
  raw_text       text,
  error_type     text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ══ D. Author intelligence ══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.anonymized_authors (
  author_hash      text PRIMARY KEY,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  account_age_days integer,
  posts_count      integer NOT NULL DEFAULT 0,
  resolved_signals integer NOT NULL DEFAULT 0,
  hit_rate         numeric(5,4) NOT NULL DEFAULT 0,
  reputation_score numeric(6,2) NOT NULL DEFAULT 0,
  is_new_account   boolean NOT NULL DEFAULT false,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.author_reputation_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_hash      text REFERENCES public.anonymized_authors(author_hash) ON DELETE CASCADE,
  snapshot_at      timestamptz NOT NULL DEFAULT now(),
  reputation_score numeric(6,2) NOT NULL DEFAULT 0,
  hit_rate         numeric(5,4) NOT NULL DEFAULT 0,
  resolved_signals integer NOT NULL DEFAULT 0,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.author_signal_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_hash   text REFERENCES public.anonymized_authors(author_hash) ON DELETE CASCADE,
  ticker        text,
  signal_type   text,
  stance        text,
  signaled_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  outcome       text,
  return_pct    numeric,
  was_early     boolean,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ══ E. Market data ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.market_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        text NOT NULL,
  snapshot_at   timestamptz NOT NULL DEFAULT now(),
  price         numeric,
  change_pct    numeric,
  volume        bigint,
  avg_volume    bigint,
  market_cap    numeric,
  beta          numeric,
  source        text NOT NULL DEFAULT 'stub',
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT market_snapshots_uniq UNIQUE (ticker, snapshot_at)
);

CREATE TABLE IF NOT EXISTS public.option_chain_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker       text NOT NULL,
  snapshot_at  timestamptz NOT NULL DEFAULT now(),
  expiration_date date,
  source       text NOT NULL DEFAULT 'stub',
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.option_contract_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_snapshot_id  uuid REFERENCES public.option_chain_snapshots(id) ON DELETE CASCADE,
  ticker             text NOT NULL,
  option_type        text CHECK (option_type IN ('call','put')),
  strike             numeric,
  expiration_date    date,
  bid                numeric,
  ask                numeric,
  mid                numeric,
  last               numeric,
  volume             integer,
  open_interest      integer,
  implied_volatility numeric,
  delta              numeric,
  gamma              numeric,
  theta              numeric,
  vega               numeric,
  snapshot_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.short_interest_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker              text NOT NULL,
  snapshot_at         timestamptz NOT NULL DEFAULT now(),
  short_interest      numeric,
  short_percent_float numeric,
  days_to_cover       numeric,
  borrow_fee          numeric,
  squeeze_risk_score  numeric,
  source              text NOT NULL DEFAULT 'stub',
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.news_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker      text,
  headline    text NOT NULL,
  url         text,
  source      text NOT NULL DEFAULT 'stub',
  sentiment   numeric,
  published_at timestamptz,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.insider_activity_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        text,
  insider_role  text,
  transaction_type text,
  shares        numeric,
  value         numeric,
  filed_at      timestamptz,
  source        text NOT NULL DEFAULT 'stub',
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.external_social_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker       text,
  platform     text NOT NULL DEFAULT 'stub',
  snapshot_at  timestamptz NOT NULL DEFAULT now(),
  mentions     integer,
  sentiment    numeric,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.catalyst_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        text,
  catalyst_type text NOT NULL,
  title         text,
  event_date    date,
  confirmed     boolean NOT NULL DEFAULT false,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ══ F. Analytics / scoring ══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.signal_scores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker       text REFERENCES public.tickers(ticker),
  bucket_start timestamptz,
  signal_type  text NOT NULL,
  score        numeric,
  confidence   numeric,
  explanation  text,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signal_scores_uniq UNIQUE (ticker, bucket_start, signal_type)
);

CREATE TABLE IF NOT EXISTS public.ticker_positioning_indexes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker                    text REFERENCES public.tickers(ticker),
  bucket_start              timestamptz,
  call_conviction           numeric,
  put_conviction            numeric,
  net_directional_conviction numeric,
  declared_yolo_capital     numeric,
  verified_yolo_capital     numeric,
  average_dte               numeric,
  average_moneyness         numeric,
  premium_at_risk           numeric,
  leveraged_sentiment       numeric,
  expiration_wall           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticker_positioning_indexes_uniq UNIQUE (ticker, bucket_start)
);

CREATE TABLE IF NOT EXISTS public.pump_coordination_scores (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker                  text REFERENCES public.tickers(ticker),
  bucket_start            timestamptz,
  score                   numeric,
  severity                text,
  repeated_phrases        jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_concentration    numeric,
  new_account_ratio       numeric,
  cross_subreddit_activity jsonb NOT NULL DEFAULT '{}'::jsonb,
  deletion_rate           numeric,
  explanation             text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pump_coordination_scores_uniq UNIQUE (ticker, bucket_start)
);

CREATE TABLE IF NOT EXISTS public.dd_quality_scores (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reddit_post_id        text REFERENCES public.reddit_posts(reddit_post_id) ON DELETE CASCADE,
  ticker                text REFERENCES public.tickers(ticker),
  score                 numeric,
  evidence_score        numeric,
  source_score          numeric,
  calculation_score     numeric,
  catalyst_score        numeric,
  risk_disclosure_score numeric,
  originality_score     numeric,
  category              text,
  explanation           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dd_quality_scores_uniq UNIQUE (reddit_post_id)
);

CREATE TABLE IF NOT EXISTS public.narrative_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        text REFERENCES public.tickers(ticker),
  narrative     text NOT NULL,
  narrative_type text,
  strength      numeric,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.narrative_transitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        text REFERENCES public.tickers(ticker),
  from_narrative text,
  to_narrative  text,
  transition_at timestamptz NOT NULL DEFAULT now(),
  confidence    numeric,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.beta_adjusted_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker              text REFERENCES public.tickers(ticker),
  signal_ref          text,
  window_days         integer,
  raw_return          numeric,
  spy_return          numeric,
  beta                numeric,
  beta_adjusted_return numeric,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.backtest_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text,
  query      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.backtest_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backtest_run_id       uuid REFERENCES public.backtest_runs(id) ON DELETE CASCADE,
  observations          integer,
  win_rate              numeric,
  median_return         numeric,
  average_return        numeric,
  max_drawdown          numeric,
  spy_adjusted_return   numeric,
  option_estimated_return numeric,
  result_distribution   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.research_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE,
  title      text NOT NULL,
  summary    text,
  body       text,
  report_type text,
  tickers    jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ══ G. Product / user ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.user_watchlists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL,
  name       text NOT NULL DEFAULT 'My Watchlist',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_watchlists_uniq UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS public.user_watchlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id uuid REFERENCES public.user_watchlists(id) ON DELETE CASCADE,
  ticker       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_watchlist_items_uniq UNIQUE (watchlist_id, ticker)
);

CREATE TABLE IF NOT EXISTS public.user_portfolio_positions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  ticker        text NOT NULL,
  quantity      numeric,
  avg_cost      numeric,
  instrument    text NOT NULL DEFAULT 'stock',
  opened_at     timestamptz,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  name        text,
  rule_type   text NOT NULL,
  ticker      text,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_alert_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_rule_id uuid REFERENCES public.user_alert_rules(id) ON DELETE CASCADE,
  user_id       text,
  ticker        text,
  channel       text NOT NULL DEFAULT 'in_app',
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivered_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  target_url  text NOT NULL,
  event_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  secret      text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.daily_summaries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text,
  day        date NOT NULL,
  summary    text,
  highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_summaries_uniq UNIQUE (user_id, day)
);

CREATE TABLE IF NOT EXISTS public.api_usage_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text,
  route      text NOT NULL,
  method     text NOT NULL DEFAULT 'GET',
  status     integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ══ H. Personal / signed-in features ════════════════════════════════════════
-- Identity is the existing public.users table (id text, cuid) populated by the
-- Reddit OAuth callback; it already stores provider id, username and avatar, so
-- it doubles as the "user_profile". Personal tables key off users(id).

-- Personal alert rules already exist as public.user_alert_rules; add the columns
-- this feature needs (idempotent).
ALTER TABLE public.user_alert_rules ADD COLUMN IF NOT EXISTS alert_type text;
ALTER TABLE public.user_alert_rules ADD COLUMN IF NOT EXISTS condition jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.user_alert_rules ADD COLUMN IF NOT EXISTS delivery_channels jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS public.user_notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.virtual_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  starting_cash numeric NOT NULL DEFAULT 100000,
  cash_balance  numeric NOT NULL DEFAULT 100000,
  equity_value  numeric NOT NULL DEFAULT 100000,
  currency      text DEFAULT 'USD',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT virtual_accounts_user_uniq UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS public.virtual_trades (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  virtual_account_id uuid REFERENCES public.virtual_accounts(id) ON DELETE CASCADE,
  ticker             text REFERENCES public.tickers(ticker),
  side               text CHECK (side IN ('buy','sell','short','cover')),
  instrument         text CHECK (instrument IN ('stock','option')),
  option_type        text CHECK (option_type IN ('call','put')),
  strike             numeric,
  expiration_date    date,
  quantity           numeric NOT NULL,
  price              numeric NOT NULL,
  notional_value     numeric NOT NULL,
  fees               numeric DEFAULT 0,
  status             text DEFAULT 'filled',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.virtual_positions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  virtual_account_id uuid REFERENCES public.virtual_accounts(id) ON DELETE CASCADE,
  ticker             text REFERENCES public.tickers(ticker),
  instrument         text,
  option_type        text,
  strike             numeric,
  expiration_date    date,
  quantity           numeric NOT NULL,
  avg_cost           numeric NOT NULL,
  market_value       numeric DEFAULT 0,
  unrealized_pl      numeric DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT virtual_positions_uniq UNIQUE (virtual_account_id, ticker, instrument, option_type, strike, expiration_date)
);

CREATE TABLE IF NOT EXISTS public.competitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  starts_at     timestamptz,
  ends_at       timestamptz,
  starting_cash numeric DEFAULT 100000,
  is_active     boolean DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.competition_participants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id     uuid REFERENCES public.competitions(id) ON DELETE CASCADE,
  user_id            text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  virtual_account_id uuid REFERENCES public.virtual_accounts(id) ON DELETE CASCADE,
  joined_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competition_participants_uniq UNIQUE (competition_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.competition_leaderboard_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid REFERENCES public.competitions(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  rank           integer,
  equity_value   numeric,
  return_pct     numeric,
  snapshot_at    timestamptz NOT NULL DEFAULT now()
);

-- ══ Indexes ═════════════════════════════════════════════════════════════════
-- Auth / email + reddit verification.
CREATE INDEX IF NOT EXISTS app_users_email_normalized_idx ON public.app_users (email_normalized);
CREATE INDEX IF NOT EXISTS user_sessions_token_hash_idx ON public.user_sessions (session_token_hash);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON public.user_sessions (user_id);
CREATE INDEX IF NOT EXISTS email_verification_tokens_hash_idx ON public.email_verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS password_reset_tokens_hash_idx ON public.password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS reddit_accounts_username_norm_idx ON public.reddit_accounts (reddit_username_normalized);
CREATE INDEX IF NOT EXISTS reddit_accounts_user_idx ON public.reddit_accounts (user_id);
CREATE INDEX IF NOT EXISTS reddit_verif_requests_user_idx ON public.reddit_verification_requests (user_id);
CREATE INDEX IF NOT EXISTS reddit_verif_requests_status_idx ON public.reddit_verification_requests (status);
CREATE INDEX IF NOT EXISTS reddit_verif_requests_code_idx ON public.reddit_verification_requests (verification_code);
CREATE INDEX IF NOT EXISTS auth_events_user_idx ON public.auth_events (user_id);

CREATE INDEX IF NOT EXISTS ticker_mentions_ticker_idx ON public.ticker_mentions (ticker);
CREATE INDEX IF NOT EXISTS ticker_mentions_created_idx ON public.ticker_mentions (created_at);
CREATE INDEX IF NOT EXISTS ticker_metrics_5m_bucket_idx ON public.ticker_metrics_5m (bucket_start);
CREATE INDEX IF NOT EXISTS ticker_alerts_ticker_idx ON public.ticker_alerts (ticker);
CREATE INDEX IF NOT EXISTS ticker_alerts_created_idx ON public.ticker_alerts (created_at);
CREATE INDEX IF NOT EXISTS reddit_comments_post_idx ON public.reddit_comments (reddit_post_id);
CREATE INDEX IF NOT EXISTS reddit_comments_author_idx ON public.reddit_comments (author_hash);
CREATE INDEX IF NOT EXISTS stance_events_ticker_idx ON public.ticker_stance_events (ticker);
CREATE INDEX IF NOT EXISTS stance_events_created_idx ON public.ticker_stance_events (created_at);
CREATE INDEX IF NOT EXISTS sub_metrics_5m_sub_idx ON public.subreddit_ticker_metrics_5m (subreddit);
CREATE INDEX IF NOT EXISTS ticker_daily_metrics_day_idx ON public.ticker_daily_metrics (day);
CREATE INDEX IF NOT EXISTS bets_ticker_idx ON public.bets (ticker);
CREATE INDEX IF NOT EXISTS bets_author_idx ON public.bets (author_hash);
CREATE INDEX IF NOT EXISTS bets_created_idx ON public.bets (created_at);
CREATE INDEX IF NOT EXISTS bets_post_idx ON public.bets (reddit_post_id);
CREATE INDEX IF NOT EXISTS bet_legs_bet_idx ON public.bet_legs (bet_id);
CREATE INDEX IF NOT EXISTS bet_legs_expiration_idx ON public.bet_legs (expiration_date);
CREATE INDEX IF NOT EXISTS bet_snapshots_bet_idx ON public.bet_snapshots (bet_id);
CREATE INDEX IF NOT EXISTS bet_performance_bet_idx ON public.bet_performance (bet_id);
CREATE INDEX IF NOT EXISTS author_signal_hist_author_idx ON public.author_signal_history (author_hash);
CREATE INDEX IF NOT EXISTS market_snapshots_ticker_idx ON public.market_snapshots (ticker);
CREATE INDEX IF NOT EXISTS market_snapshots_at_idx ON public.market_snapshots (snapshot_at);
CREATE INDEX IF NOT EXISTS option_contract_ticker_idx ON public.option_contract_snapshots (ticker);
CREATE INDEX IF NOT EXISTS news_events_ticker_idx ON public.news_events (ticker);
CREATE INDEX IF NOT EXISTS signal_scores_ticker_idx ON public.signal_scores (ticker);
CREATE INDEX IF NOT EXISTS signal_scores_type_idx ON public.signal_scores (signal_type);
CREATE INDEX IF NOT EXISTS positioning_ticker_idx ON public.ticker_positioning_indexes (ticker);
CREATE INDEX IF NOT EXISTS pump_scores_ticker_idx ON public.pump_coordination_scores (ticker);
CREATE INDEX IF NOT EXISTS dd_scores_ticker_idx ON public.dd_quality_scores (ticker);
CREATE INDEX IF NOT EXISTS narrative_events_ticker_idx ON public.narrative_events (ticker);
CREATE INDEX IF NOT EXISTS watchlist_items_ticker_idx ON public.user_watchlist_items (ticker);
CREATE INDEX IF NOT EXISTS portfolio_user_idx ON public.user_portfolio_positions (user_id);
CREATE INDEX IF NOT EXISTS user_notifications_user_idx ON public.user_notifications (user_id);
CREATE INDEX IF NOT EXISTS virtual_accounts_user_idx ON public.virtual_accounts (user_id);
CREATE INDEX IF NOT EXISTS virtual_trades_user_idx ON public.virtual_trades (user_id);
CREATE INDEX IF NOT EXISTS virtual_trades_account_idx ON public.virtual_trades (virtual_account_id);
CREATE INDEX IF NOT EXISTS virtual_positions_account_idx ON public.virtual_positions (virtual_account_id);
CREATE INDEX IF NOT EXISTS competition_participants_comp_idx ON public.competition_participants (competition_id);
CREATE INDEX IF NOT EXISTS competition_leaderboard_comp_idx ON public.competition_leaderboard_snapshots (competition_id);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Enable Row Level Security on every project table. bwsb connects with the
// service role, which bypasses RLS; the frontend never connects to the database
// directly. With RLS on and no permissive policies, anon/authenticated clients
// get zero rows — reads must go through the backend API.
// ─────────────────────────────────────────────────────────────────────────────
const RLS_SQL = /* sql */ `
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
`;

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();
  const client = new Client({ connectionString });

  try {
    console.log("🔌 Connecting to the database…");
    await client.connect();

    console.log("🏗️  Creating schema (idempotent)…");
    await client.query("BEGIN");
    await client.query(SCHEMA_SQL);
    await client.query("COMMIT");

    console.log("🔒 Enabling Row Level Security on all public tables…");
    await client.query(RLS_SQL);

    console.log("✅ Schema is ready.");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors — the original error is what matters.
    }
    console.error(
      "❌ Failed to set up the database:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  } finally {
    await client.end();
  }
}

void main();
