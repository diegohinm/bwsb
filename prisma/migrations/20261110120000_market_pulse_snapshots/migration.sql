-- MARKET PULSE — the Dashboard's aggregate crowd-direction gauge.
--
-- One row per timeframe per worker run (jobs/refreshMarketPulse.job.ts). The
-- worker counts the stance of every (Reddit item, ticker) mention stored in
-- social_posts / social_comments inside the window, from real providers only,
-- and derives the 0..100 score from those counts. The API only reads the newest
-- row — it never recounts and never calls a provider.
--
-- THE INPUTS ARE STORED, NOT JUST THE OUTPUT. Every count that feeds the score
-- is a column, together with the formula version and the minimum sample used,
-- so any published score can be recomputed and audited from its own row, and a
-- future formula is introduced beside v1 rather than silently rewriting history.
--
-- `score` is NULL when the sample was too small to publish one. NULL is the
-- honest value there: 50 would claim a balanced crowd that nobody measured.
--
-- Additive only: a new table, two indexes, RLS. Nothing existing is touched.

CREATE TABLE IF NOT EXISTS "market_pulse_snapshots" (
    "id"                   UUID           NOT NULL DEFAULT gen_random_uuid(),
    "timeframe"            TEXT           NOT NULL,
    "window_start"         TIMESTAMPTZ(6) NOT NULL,
    "window_end"           TIMESTAMPTZ(6) NOT NULL,

    -- 0..100, or NULL when classified mentions < min_classified_mentions.
    "score"                INTEGER,

    -- Mentions = (item, distinct ticker) pairs. Stance counts only include
    -- mentions whose item carries a recognised stance; anything else is
    -- `unclassified_count` and stays out of the score's denominator.
    "bullish_count"        INTEGER        NOT NULL DEFAULT 0,
    "neutral_count"        INTEGER        NOT NULL DEFAULT 0,
    "bearish_count"        INTEGER        NOT NULL DEFAULT 0,
    "unclassified_count"   INTEGER        NOT NULL DEFAULT 0,
    "mention_count"        INTEGER        NOT NULL DEFAULT 0,
    "item_count"           INTEGER        NOT NULL DEFAULT 0,
    "post_count"           INTEGER        NOT NULL DEFAULT 0,
    "comment_count"        INTEGER        NOT NULL DEFAULT 0,
    "ticker_count"         INTEGER        NOT NULL DEFAULT 0,
    "subreddits"           TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Real social provider(s) the mentions came from, e.g. "arctic_shift".
    -- NULL when the window held no real mention at all.
    "provider"             TEXT,
    -- Ticker-bearing items in the window from the mock provider, or with no
    -- recorded provider: seen, and deliberately NOT counted.
    "excluded_item_count"  INTEGER        NOT NULL DEFAULT 0,

    "min_classified_mentions" INTEGER     NOT NULL,
    "formula_version"      TEXT           NOT NULL,
    -- posted_at of the newest counted mention.
    "latest_mention_at"    TIMESTAMPTZ(6),
    "snapshot_at"          TIMESTAMPTZ(6) NOT NULL,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "market_pulse_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "market_pulse_snapshots_score_range"
        CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 100))
);

-- The API's only read: newest snapshot for a timeframe.
CREATE INDEX IF NOT EXISTS "market_pulse_snapshots_tf_idx"
    ON "market_pulse_snapshots"("timeframe", "snapshot_at" DESC);

-- Row level security, matching every other table in this database.
ALTER TABLE "market_pulse_snapshots" ENABLE ROW LEVEL SECURITY;
