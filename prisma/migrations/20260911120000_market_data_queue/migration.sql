-- THE MARKET-DATA WORK QUEUE.
--
-- Market refresh was a hardcoded list of sixteen symbols on a fixed timer. Every
-- symbol was refreshed at the same rate whether anyone was looking at it, and a
-- symbol nobody had hardcoded was never refreshed at all however loudly Reddit
-- was talking about it. Demand and supply were unrelated.
--
-- A row here is a REQUEST, not a promise. The worker decides when, batches what
-- it can, and no read path ever waits on one.
--
-- Postgres rather than Redis/RabbitMQ: the single guarantee this queue needs is
-- that two workers cannot claim the same row, and FOR UPDATE SKIP LOCKED
-- provides it natively. A broker would add an operational dependency to buy
-- something the database already does.

CREATE TABLE IF NOT EXISTS "market_data_jobs" (
    "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    "ticker"          TEXT        NOT NULL,
    "job_type"        TEXT        NOT NULL,
    "priority"        INTEGER     NOT NULL DEFAULT 3,
    "status"          TEXT        NOT NULL DEFAULT 'PENDING',
    "params"          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    "requested_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "started_at"      TIMESTAMPTZ(6),
    "processed_at"    TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6),
    "attempts"        INTEGER     NOT NULL DEFAULT 0,
    "error"           TEXT,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- TEXT + CHECK rather than a Postgres enum, as elsewhere in this schema: adding
-- a job type later is an ALTER of a constraint instead of a type migration with
-- its own deployment-ordering problem.
ALTER TABLE "market_data_jobs" DROP CONSTRAINT IF EXISTS "market_data_jobs_job_type_check";
ALTER TABLE "market_data_jobs" ADD CONSTRAINT "market_data_jobs_job_type_check"
    CHECK ("job_type" IN ('QUOTE', 'SNAPSHOT', 'CANDLES'));

ALTER TABLE "market_data_jobs" DROP CONSTRAINT IF EXISTS "market_data_jobs_status_check";
ALTER TABLE "market_data_jobs" ADD CONSTRAINT "market_data_jobs_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED'));

-- Priority 1 (someone is looking at this symbol now) through 4 (background).
ALTER TABLE "market_data_jobs" DROP CONSTRAINT IF EXISTS "market_data_jobs_priority_check";
ALTER TABLE "market_data_jobs" ADD CONSTRAINT "market_data_jobs_priority_check"
    CHECK ("priority" BETWEEN 1 AND 4);

-- The claim query's exact access path: open work, best priority first, oldest
-- first within a priority.
CREATE INDEX IF NOT EXISTS "market_data_jobs_claim_idx"
    ON "market_data_jobs" ("status", "priority", "requested_at");

-- Deduplication reads this before every enqueue: is there already open work for
-- this symbol and job type?
CREATE INDEX IF NOT EXISTS "market_data_jobs_dedupe_idx"
    ON "market_data_jobs" ("ticker", "job_type", "status");

CREATE INDEX IF NOT EXISTS "market_data_jobs_retry_idx"
    ON "market_data_jobs" ("status", "next_attempt_at");
