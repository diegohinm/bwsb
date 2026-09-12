-- PRE-AGGREGATED REDDIT ATTENTION (Top Tickers / Hot Tickers).
--
-- Replaces a per-request scan of social_post_tickers + social_comment_tickers,
-- joined to their parent rows for posted_at/stance and run TWICE per summary
-- (current window + comparison window), with fixed 5-minute buckets written
-- once at ingestion. A 24h ranking becomes a sum over 288 narrow rows.
--
-- bucket_minutes is part of the key so a coarser rollup can be written into the
-- same table later without a migration, and so a row always declares its own
-- granularity rather than inheriting one from a constant in application code.
--
-- NO FOREIGN KEY to tickers: the extractor only emits catalog-validated
-- symbols, and a catalog refresh that retires one must never be able to make
-- Reddit aggregation writes fail.

CREATE TABLE IF NOT EXISTS "ticker_activity" (
    "id"             BIGSERIAL PRIMARY KEY,
    "ticker"         TEXT        NOT NULL,
    "subreddit"      TEXT        NOT NULL,
    "bucket_start"   TIMESTAMPTZ(6) NOT NULL,
    "bucket_minutes" INTEGER     NOT NULL DEFAULT 5,
    "mentions"       INTEGER     NOT NULL DEFAULT 0,
    "posts"          INTEGER     NOT NULL DEFAULT 0,
    "comments"       INTEGER     NOT NULL DEFAULT 0,
    "bullish"        INTEGER     NOT NULL DEFAULT 0,
    "neutral"        INTEGER     NOT NULL DEFAULT 0,
    "bearish"        INTEGER     NOT NULL DEFAULT 0,
    "unique_authors" INTEGER     NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The upsert target. Every aggregation write is ON CONFLICT on this key, which
-- is what makes concurrent ingestion workers safe without an explicit lock.
CREATE UNIQUE INDEX IF NOT EXISTS "ticker_activity_bucket_uniq"
    ON "ticker_activity" ("ticker", "subreddit", "bucket_start", "bucket_minutes");

-- Top/Hot tickers for one community over a window.
CREATE INDEX IF NOT EXISTS "ticker_activity_subreddit_idx"
    ON "ticker_activity" ("subreddit", "bucket_start" DESC);
-- One ticker's history, for the ticker page and for market-data prioritization.
CREATE INDEX IF NOT EXISTS "ticker_activity_ticker_idx"
    ON "ticker_activity" ("ticker", "bucket_start" DESC);
-- Cross-community window scans and retention sweeps.
CREATE INDEX IF NOT EXISTS "ticker_activity_bucket_idx"
    ON "ticker_activity" ("bucket_start" DESC);

-- WHICH AUTHORS APPEAR IN A BUCKET.
--
-- unique_authors cannot be a running total: one account posting forty times
-- about NVDA would be counted as forty people, inverting the meaning of the
-- only metric that separates broad interest from one loud poster.
--
-- Membership is therefore stored, the insert is ON CONFLICT DO NOTHING, and the
-- counter is advanced ONLY when a row was actually created. The unique index
-- arbitrates between concurrent workers, so no application-level lock is needed.
--
-- author_hash, never a username: the same pseudonymous value social_posts and
-- social_comments already store.
CREATE TABLE IF NOT EXISTS "ticker_activity_authors" (
    "ticker"         TEXT        NOT NULL,
    "subreddit"      TEXT        NOT NULL,
    "bucket_start"   TIMESTAMPTZ(6) NOT NULL,
    "bucket_minutes" INTEGER     NOT NULL DEFAULT 5,
    "author_hash"    TEXT        NOT NULL,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "ticker_activity_authors_pkey"
        PRIMARY KEY ("ticker", "subreddit", "bucket_start", "bucket_minutes", "author_hash")
);

-- Retention sweeps only. Reads always go through the primary key.
CREATE INDEX IF NOT EXISTS "ticker_activity_authors_bucket_idx"
    ON "ticker_activity_authors" ("bucket_start");
