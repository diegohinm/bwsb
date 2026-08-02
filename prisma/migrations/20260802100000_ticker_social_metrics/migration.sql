-- Per-ticker social activity, pre-bucketed by the ingestion worker.
--
-- Added so two read paths stop scanning the raw content tables on every page
-- request: the Feel % column (sum the buckets inside a window) and the
-- mentions-trend chart (plot them). Both are the same measurement at different
-- resolutions, so they share one table.
--
-- Four bucket sizes are stored — 5m, 30m, 1h, 6h — one per UI window (1H, 6H,
-- 24H, 7D). The worker recomputes and replaces the recent window on each run,
-- which is why the natural key is UNIQUE: re-running is idempotent rather than
-- duplicating history.
--
-- `mentions` counts every item referencing the ticker; the three stance columns
-- count only CLASSIFIED items. Their sum can therefore be lower than `mentions`,
-- which is deliberate: an unclassified post must not be filed as neutral.

-- CreateTable
CREATE TABLE "ticker_social_metric_snapshots" (
    "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
    "ticker"        TEXT           NOT NULL,
    "bucket_start"  TIMESTAMPTZ(6) NOT NULL,
    "bucket_size"   TEXT           NOT NULL,
    "mentions"      INTEGER        NOT NULL DEFAULT 0,
    "bullish_count" INTEGER        NOT NULL DEFAULT 0,
    "neutral_count" INTEGER        NOT NULL DEFAULT 0,
    "bearish_count" INTEGER        NOT NULL DEFAULT 0,
    "provider"      TEXT,
    "source"        TEXT,
    "is_mock"       BOOLEAN        NOT NULL DEFAULT false,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ticker_social_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The natural key. Makes the worker's recompute idempotent and serves the
-- per-ticker window read (Feel %) and the per-ticker series read (trend).
CREATE UNIQUE INDEX "ticker_social_metrics_unique"
    ON "ticker_social_metric_snapshots"("ticker", "bucket_size", "bucket_start" DESC);

-- CreateIndex
-- Serves the worker's "replace the recent window for this bucket size" delete.
CREATE INDEX "ticker_social_metrics_bucket_idx"
    ON "ticker_social_metric_snapshots"("bucket_size", "bucket_start" DESC);

-- Row level security, matching every other table in this database.
ALTER TABLE "ticker_social_metric_snapshots" ENABLE ROW LEVEL SECURITY;
