/**
 * setupDatabase.ts
 *
 * Creates the database schema for bwsb (backend for StonkTerminal, internal
 * project "wsb"). This script is idempotent — every statement uses
 * IF NOT EXISTS so it is safe to run repeatedly.
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

/**
 * Read and validate DATABASE_URL without ever logging its value.
 */
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

const SCHEMA_SQL = /* sql */ `
-- Reference table of tracked tickers.
CREATE TABLE IF NOT EXISTS public.tickers (
  ticker         text PRIMARY KEY,
  company_name   text,
  exchange       text,
  is_active      boolean DEFAULT true,
  is_common_word boolean DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Raw Reddit posts we have ingested.
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

-- A mention of a ticker inside a specific Reddit post.
CREATE TABLE IF NOT EXISTS public.ticker_mentions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker              text NOT NULL REFERENCES public.tickers(ticker),
  reddit_post_id      text NOT NULL REFERENCES public.reddit_posts(reddit_post_id),
  pump_language_score numeric(5, 4) NOT NULL DEFAULT 0,
  narrative_type      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- One mention per ticker per post keeps the seed idempotent.
  CONSTRAINT ticker_mentions_ticker_post_uniq UNIQUE (ticker, reddit_post_id)
);

-- Rolling 5-minute aggregate metrics per ticker.
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

-- Alerts raised for a ticker, with a snapshot of the metrics at trigger time.
CREATE TABLE IF NOT EXISTS public.ticker_alerts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker           text NOT NULL REFERENCES public.tickers(ticker),
  alert_type       text NOT NULL,
  severity         text NOT NULL,
  metrics_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Helpful indexes for common lookups.
CREATE INDEX IF NOT EXISTS ticker_mentions_ticker_idx
  ON public.ticker_mentions (ticker);
CREATE INDEX IF NOT EXISTS ticker_metrics_5m_bucket_idx
  ON public.ticker_metrics_5m (bucket_start);
CREATE INDEX IF NOT EXISTS ticker_alerts_ticker_idx
  ON public.ticker_alerts (ticker);
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
