-- Arctic Shift ingestion worker: rotation state and per-subreddit cursors.
--
-- The worker makes ONE upstream request every five minutes, rotating through
-- REDDIT_SUBREDDITS. Two pieces of state have to outlive the process for that
-- promise to hold across restarts and across a second Render instance:
--
--   reddit_worker_state       who is next, when the last request left, the
--                             rolling one-hour request log, the 429 block, and
--                             the lease that serializes instances.
--   reddit_ingestion_cursors  where each subreddit's window resumes.
--
-- A LEASE, NOT AN ADVISORY LOCK: the database is reached through the Supabase
-- transaction pooler, where a connection is not a session — pg_advisory_lock
-- would be taken on a connection that is handed to somebody else moments later.
-- A compare-and-swap on (locked_by, locked_until) is pooler-safe and expires on
-- its own if a worker dies holding it.
--
-- Both tables are new; nothing existing is altered or deleted.

CREATE TABLE IF NOT EXISTS "reddit_worker_state" (
    "id"                      UUID         NOT NULL DEFAULT gen_random_uuid(),
    "worker_name"             TEXT         NOT NULL,
    "next_subreddit_index"    INTEGER      NOT NULL DEFAULT 0,
    "last_request_at"         TIMESTAMPTZ(6),
    "last_successful_run_at"  TIMESTAMPTZ(6),
    "consecutive_failures"    INTEGER      NOT NULL DEFAULT 0,
    "blocked_until"           TIMESTAMPTZ(6),
    "request_log"             JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "locked_by"               TEXT,
    "locked_until"            TIMESTAMPTZ(6),
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "reddit_worker_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reddit_worker_state_worker_name_key"
    ON "reddit_worker_state" ("worker_name");

CREATE TABLE IF NOT EXISTS "reddit_ingestion_cursors" (
    "id"                        UUID         NOT NULL DEFAULT gen_random_uuid(),
    "provider"                  TEXT         NOT NULL,
    "subreddit"                 TEXT         NOT NULL,
    "content_type"              TEXT         NOT NULL,
    "last_created_at"           TIMESTAMPTZ(6),
    "last_external_id"          TEXT,
    "last_attempt_at"           TIMESTAMPTZ(6),
    "last_successful_sync_at"   TIMESTAMPTZ(6),
    "last_error_code"           TEXT,
    "last_error_message"        TEXT,
    "consecutive_failures"      INTEGER      NOT NULL DEFAULT 0,
    "has_more"                  BOOLEAN      NOT NULL DEFAULT false,
    "cooldown_until"            TIMESTAMPTZ(6),
    "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "reddit_ingestion_cursors_pkey" PRIMARY KEY ("id")
);

-- One cursor per (provider, subreddit, content type): Arctic Shift and Mindcase
-- track the same community independently, and posts independently of comments.
CREATE UNIQUE INDEX IF NOT EXISTS "reddit_ingestion_cursors_unique"
    ON "reddit_ingestion_cursors" ("provider", "subreddit", "content_type");

CREATE INDEX IF NOT EXISTS "reddit_ingestion_cursors_provider_idx"
    ON "reddit_ingestion_cursors" ("provider", "subreddit");
