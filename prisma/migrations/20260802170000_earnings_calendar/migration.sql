-- Earnings calendar: worker-written events + per-user calendar personalization.
--
-- `earnings_events` is a LIVE record keyed by external_id, not an append-only
-- snapshot: re-fetching the same fiscal quarter updates the row. `status` and
-- `timing` default to the honest values ('estimated' / 'unknown') so a provider
-- that omits them can never make a date look confirmed or invent a clock time.

CREATE TABLE IF NOT EXISTS "earnings_events" (
    "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
    "symbol"           TEXT         NOT NULL,
    "company_name"     TEXT,
    "report_date"      DATE         NOT NULL,
    "report_time"      TIMESTAMPTZ(6),
    "timing"           TEXT         NOT NULL DEFAULT 'unknown',
    "status"           TEXT         NOT NULL DEFAULT 'estimated',
    "fiscal_quarter"   TEXT,
    "fiscal_year"      INTEGER,
    "eps_estimate"     DECIMAL,
    "eps_actual"       DECIMAL,
    "revenue_estimate" DECIMAL,
    "revenue_actual"   DECIMAL,
    "provider"         TEXT         NOT NULL,
    "source"           TEXT,
    "external_id"      TEXT,
    "is_mock"          BOOLEAN      NOT NULL DEFAULT false,
    "fetched_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "earnings_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "earnings_events_external_id_key"
    ON "earnings_events" ("external_id");
CREATE INDEX IF NOT EXISTS "earnings_events_date_idx"
    ON "earnings_events" ("report_date");
CREATE INDEX IF NOT EXISTS "earnings_events_symbol_date_idx"
    ON "earnings_events" ("symbol", "report_date");
CREATE INDEX IF NOT EXISTS "earnings_events_status_date_idx"
    ON "earnings_events" ("status", "report_date");

-- One personalization row per account. Cascades with the account: deleting a
-- user must not leave their ticker selection behind.
CREATE TABLE IF NOT EXISTS "user_calendar_preferences" (
    "id"                        UUID    NOT NULL DEFAULT gen_random_uuid(),
    "user_id"                   UUID    NOT NULL,
    "selected_tickers"          TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
    "include_watchlist"         BOOLEAN NOT NULL DEFAULT true,
    "include_virtual_positions" BOOLEAN NOT NULL DEFAULT true,
    "include_trending_tickers"  BOOLEAN NOT NULL DEFAULT false,
    "default_view"              TEXT    NOT NULL DEFAULT 'month',
    "timezone"                  TEXT    NOT NULL DEFAULT 'America/New_York',
    "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "user_calendar_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_calendar_preferences_user_id_key"
    ON "user_calendar_preferences" ("user_id");

ALTER TABLE "user_calendar_preferences"
    DROP CONSTRAINT IF EXISTS "user_calendar_preferences_user_id_fkey";
ALTER TABLE "user_calendar_preferences"
    ADD CONSTRAINT "user_calendar_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_users" ("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
