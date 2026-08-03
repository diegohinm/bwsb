-- Equity readings over time, so "day P/L" and "month P/L" have a baseline.
--
-- The canonical equity stays CALCULATED (cash + marked positions); this table
-- is history, not a second opinion. Until it has rows, the P/L figures are
-- returned as NULL rather than 0 — an unknown change is not no change.

CREATE TABLE IF NOT EXISTS "virtual_equity_snapshots" (
    "id"                     UUID    NOT NULL DEFAULT gen_random_uuid(),
    "virtual_account_id"     UUID    NOT NULL,
    "user_id"                UUID    NOT NULL,
    "cash_balance"           DECIMAL NOT NULL,
    "positions_market_value" DECIMAL NOT NULL,
    "equity_value"           DECIMAL NOT NULL,
    "calculated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "price_observed_at"      TIMESTAMPTZ(6),
    "is_stale"               BOOLEAN NOT NULL DEFAULT false,
    "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "virtual_equity_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "virtual_equity_snapshots_account_idx"
    ON "virtual_equity_snapshots" ("virtual_account_id", "calculated_at" DESC);
CREATE INDEX IF NOT EXISTS "virtual_equity_snapshots_user_idx"
    ON "virtual_equity_snapshots" ("user_id", "calculated_at" DESC);

ALTER TABLE "virtual_equity_snapshots"
    DROP CONSTRAINT IF EXISTS "virtual_equity_snapshots_account_fkey";
ALTER TABLE "virtual_equity_snapshots"
    ADD CONSTRAINT "virtual_equity_snapshots_account_fkey"
    FOREIGN KEY ("virtual_account_id") REFERENCES "virtual_accounts" ("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
