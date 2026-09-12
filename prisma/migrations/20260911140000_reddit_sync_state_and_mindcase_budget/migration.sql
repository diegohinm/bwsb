-- INCREMENTAL REDDIT SYNC STATE + THE MINDCASE BILLING LEDGER.
--
-- Mindcase bills per ROW RETURNED (~$0.005). The ingestion that existed swept
-- five subreddits every ten minutes asking for 50 rows each — 250 billable rows
-- per cycle, ~36,000/day, ~$180/day — and then discarded the duplicates
-- CLIENT-SIDE, because the agent has no server-side time filter. The watermark
-- was real; the saving was not.
--
-- These columns are what let a sync ask for the smallest useful number of rows
-- and stop as soon as it recognises one it already has.

-- ── reddit_ingestion_cursors: per-stream, per-thread sync state ──────────────

-- EMPTY STRING, NOT NULL, for the subreddit-level cursor. Postgres treats NULLs
-- as distinct in a unique index, so a nullable thread_id would permit two rows
-- for the same stream — and two cursors for one stream means one is always
-- behind, re-buying rows the other already paid for.
ALTER TABLE "reddit_ingestion_cursors"
    ADD COLUMN IF NOT EXISTS "thread_id" TEXT NOT NULL DEFAULT '';

-- Per-stream due time. A quiet thread backs off on its own, without the
-- scheduler having to hold a timer per thread.
ALTER TABLE "reddit_ingestion_cursors"
    ADD COLUMN IF NOT EXISTS "next_sync_at" TIMESTAMPTZ(6);

ALTER TABLE "reddit_ingestion_cursors"
    ADD COLUMN IF NOT EXISTS "consecutive_empty_runs" INTEGER NOT NULL DEFAULT 0;

-- What the last sync cost and what it yielded. The ONLY cost lever this provider
-- exposes is how many rows a request asks for, so the next request is sized from
-- the previous one's yield rather than from a constant.
ALTER TABLE "reddit_ingestion_cursors"
    ADD COLUMN IF NOT EXISTS "last_rows_received" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "reddit_ingestion_cursors"
    ADD COLUMN IF NOT EXISTS "last_new_items" INTEGER NOT NULL DEFAULT 0;

-- 0 = the live megathread, 1 = a busy recent post, 2 = everything else.
ALTER TABLE "reddit_ingestion_cursors"
    ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 2;

-- A thread that has gone quiet is never polled again. Without this the comment
-- sweep grows without bound: every thread ever seen stays in the rotation.
ALTER TABLE "reddit_ingestion_cursors"
    ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;

-- The unique key gains thread_id. Existing rows already carry '' from the
-- column default, so they keep their identity and no data is rewritten.
ALTER TABLE "reddit_ingestion_cursors"
    DROP CONSTRAINT IF EXISTS "reddit_ingestion_cursors_unique";
DROP INDEX IF EXISTS "reddit_ingestion_cursors_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "reddit_ingestion_cursors_unique"
    ON "reddit_ingestion_cursors" ("provider", "subreddit", "content_type", "thread_id");

-- The scheduler's pick query, in index order: active streams of one type,
-- most important first, that are due now.
CREATE INDEX IF NOT EXISTS "reddit_ingestion_cursors_due_idx"
    ON "reddit_ingestion_cursors" ("content_type", "is_active", "priority", "next_sync_at");

-- ── mindcase_usage_events: the billing ledger ────────────────────────────────
--
-- A TABLE, not an in-process counter, and that is the whole point. A counter
-- resets on every deploy, so "spend at most $50 today" would not survive one —
-- and a crash-looping worker with an in-memory budget is an unbounded invoice.
CREATE TABLE IF NOT EXISTS "mindcase_usage_events" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "agent"              TEXT NOT NULL,
    "community"          TEXT NOT NULL,
    "thread_id"          TEXT NOT NULL DEFAULT '',
    -- THE BILLABLE NUMBER. Everything else is commentary on it.
    "rows_received"      INTEGER NOT NULL,
    "new_items"          INTEGER NOT NULL DEFAULT 0,
    "duplicate_items"    INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DECIMAL(12, 6) NOT NULL,
    "duration_ms"        INTEGER,
    "outcome"            TEXT NOT NULL DEFAULT 'success',
    "error"              TEXT,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE "mindcase_usage_events" DROP CONSTRAINT IF EXISTS "mindcase_usage_events_outcome_check";
ALTER TABLE "mindcase_usage_events" ADD CONSTRAINT "mindcase_usage_events_outcome_check"
    CHECK ("outcome" IN ('success', 'empty', 'error'));

-- The budget query: sum rows and cost over a rolling hour/day.
CREATE INDEX IF NOT EXISTS "mindcase_usage_created_idx"
    ON "mindcase_usage_events" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "mindcase_usage_agent_idx"
    ON "mindcase_usage_events" ("agent", "created_at" DESC);
