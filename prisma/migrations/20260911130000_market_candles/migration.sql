-- HISTORICAL BARS, CACHED.
--
-- A candle for a minute that has already closed never changes again.
-- GET /api/market-data/candles/:symbol went straight through to the provider on
-- every request, behind a ten-second in-memory cache that a deploy erased — so
-- the same month of NVDA bars was bought over and over.
--
-- The primary key is what makes filling idempotent: the worker can re-request
-- an overlapping range and overwrite the same rows, so a download interrupted
-- half way needs no bookkeeping of its own to resume.

CREATE TABLE IF NOT EXISTS "market_candles" (
    "ticker"     TEXT        NOT NULL,
    "interval"   TEXT        NOT NULL,
    -- The bar's OPEN time, UTC. Half-open [timestamp, timestamp + interval).
    "timestamp"  TIMESTAMPTZ(6) NOT NULL,
    "open"       DECIMAL,
    "high"       DECIMAL,
    "low"        DECIMAL,
    "close"      DECIMAL,
    "volume"     DECIMAL,
    "provider"   TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "market_candles_pkey" PRIMARY KEY ("ticker", "interval", "timestamp")
);

-- Chart reads are always "this symbol, this interval, newest first, bounded by
-- a range" — and gap detection asks the same question. DESC matches both.
CREATE INDEX IF NOT EXISTS "market_candles_lookup_idx"
    ON "market_candles" ("ticker", "interval", "timestamp" DESC);
