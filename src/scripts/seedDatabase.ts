/**
 * seedDatabase.ts
 *
 * Seeds development / test data for bwsb (backend for StonkTerminal, internal
 * project "wsb"). All data here is FAKE and deterministic:
 *   - No real Reddit usernames — author identities are fake `dev_author_*` hashes.
 *   - Post ids are deterministic `dev_post_*` values so reruns are idempotent.
 *
 * The seed is fully idempotent: running it multiple times will not duplicate
 * rows. It uses ON CONFLICT upserts and deletes previous seed rows for tables
 * without a natural conflict target.
 *
 * SERVER-SIDE ONLY. Reads DATABASE_URL from the environment and connects with
 * the pg driver. DATABASE_URL is never exposed to the frontend and is never
 * logged in full.
 *
 * Usage:
 *   npm run db:seed
 *
 * This does NOT run automatically when the server starts. Run it by hand only
 * against development / test databases.
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

/**
 * Insert / upsert the tracked tickers. Idempotent via ON CONFLICT (ticker).
 */
const SEED_TICKERS_SQL = /* sql */ `
INSERT INTO public.tickers (ticker, company_name, exchange, is_active, is_common_word)
VALUES
  ('RDDT', 'Reddit, Inc.',                'NYSE',   true, false),
  ('POET', 'POET Technologies Inc.',      'NASDAQ', true, false),
  ('MU',   'Micron Technology, Inc.',     'NASDAQ', true, false),
  ('NVDA', 'NVIDIA Corporation',          'NASDAQ', true, false),
  ('TSLA', 'Tesla, Inc.',                 'NASDAQ', true, false),
  ('GME',  'GameStop Corp.',              'NYSE',   true, false),
  ('AMC',  'AMC Entertainment Holdings',  'NYSE',   true, false),
  ('PLTR', 'Palantir Technologies Inc.',  'NASDAQ', true, false),
  ('HOOD', 'Robinhood Markets, Inc.',     'NASDAQ', true, false),
  ('SOFI', 'SoFi Technologies, Inc.',     'NASDAQ', true, false),
  ('AI',   'C3.ai, Inc.',                 'NYSE',   true, true),
  ('ON',   'ON Semiconductor Corp.',      'NASDAQ', true, true)
ON CONFLICT (ticker) DO UPDATE SET
  company_name   = EXCLUDED.company_name,
  exchange       = EXCLUDED.exchange,
  is_active      = EXCLUDED.is_active,
  is_common_word = EXCLUDED.is_common_word;
`;

/**
 * Fake Reddit posts. Deterministic ids -> idempotent via ON CONFLICT.
 * reddit_created_at is relative to now() so the data always looks "fresh".
 */
const SEED_POSTS_SQL = /* sql */ `
INSERT INTO public.reddit_posts (
  reddit_post_id, subreddit, title, body_excerpt, author_hash,
  score, num_comments, permalink, reddit_created_at
)
VALUES
  (
    'dev_post_rddt_001', 'wallstreetbets',
    'RDDT calls before earnings?',
    'Retail traders are watching RDDT closely. Mentions are starting to pick up.',
    'dev_author_001', 128, 44,
    'https://reddit.com/r/wallstreetbets/comments/dev_post_rddt_001',
    now() - interval '55 minutes'
  ),
  (
    'dev_post_poet_001', 'wallstreetbets',
    'POET squeeze incoming or another trap?',
    'People are talking about POET again. Some comments sound very promotional.',
    'dev_author_002', 242, 91,
    'https://reddit.com/r/wallstreetbets/comments/dev_post_poet_001',
    now() - interval '45 minutes'
  ),
  (
    'dev_post_mu_001', 'wallstreetbets',
    'MU memory cycle is heating up',
    'Micron and HBM narrative getting attention with semiconductor traders.',
    'dev_author_003', 96, 32,
    'https://reddit.com/r/wallstreetbets/comments/dev_post_mu_001',
    now() - interval '35 minutes'
  ),
  (
    'dev_post_nvda_001', 'wallstreetbets',
    'NVDA still the king or too crowded?',
    'NVDA is mentioned again, but the trade may already be crowded.',
    'dev_author_004', 310, 140,
    'https://reddit.com/r/wallstreetbets/comments/dev_post_nvda_001',
    now() - interval '25 minutes'
  ),
  (
    'dev_post_gme_001', 'wallstreetbets',
    'GME nostalgia is back',
    'GME mentions spiked after meme-stock chatter returned.',
    'dev_author_005', 190, 77,
    'https://reddit.com/r/wallstreetbets/comments/dev_post_gme_001',
    now() - interval '20 minutes'
  )
ON CONFLICT (reddit_post_id) DO UPDATE SET
  subreddit         = EXCLUDED.subreddit,
  title             = EXCLUDED.title,
  body_excerpt      = EXCLUDED.body_excerpt,
  author_hash       = EXCLUDED.author_hash,
  score             = EXCLUDED.score,
  num_comments      = EXCLUDED.num_comments,
  permalink         = EXCLUDED.permalink,
  reddit_created_at = EXCLUDED.reddit_created_at;
`;

/**
 * Mentions linking the fake tickers to the fake posts.
 *
 * We first delete any existing seed mentions (those attached to dev_post_*
 * posts) so reruns never accumulate duplicates, then re-insert a clean set.
 */
const SEED_MENTIONS_SQL = /* sql */ `
DELETE FROM public.ticker_mentions
WHERE reddit_post_id LIKE 'dev_post_%';

INSERT INTO public.ticker_mentions (
  ticker, reddit_post_id, pump_language_score, narrative_type
)
VALUES
  ('RDDT', 'dev_post_rddt_001', 0.20, 'early_narrative'),
  ('POET', 'dev_post_poet_001', 0.85, 'pump_risk'),
  ('MU',   'dev_post_mu_001',   0.15, 'momentum_confirmation'),
  ('NVDA', 'dev_post_nvda_001', 0.50, 'late_crowded_trade'),
  ('GME',  'dev_post_gme_001',  0.75, 'meme_revival')
ON CONFLICT (ticker, reddit_post_id) DO UPDATE SET
  pump_language_score = EXCLUDED.pump_language_score,
  narrative_type      = EXCLUDED.narrative_type;
`;

/**
 * One current 5-minute bucket per ticker.
 * Idempotent via ON CONFLICT (ticker, bucket_start).
 */
const SEED_METRICS_SQL = /* sql */ `
INSERT INTO public.ticker_metrics_5m (
  ticker, bucket_start, mentions, posts_count, unique_authors, avg_score,
  total_comments, mention_velocity, abnormality_score, sentiment_score,
  pump_language_score
)
VALUES
  ('RDDT', date_trunc('minute', now()), 42,  7, 35,  87, 210,  6.2,  8.4, 0.62, 0.25),
  ('POET', date_trunc('minute', now()), 84, 13, 41, 115, 390, 18.5, 26.0, 0.48, 0.86),
  ('MU',   date_trunc('minute', now()), 31,  5, 28,  64, 120,  3.8,  4.1, 0.71, 0.18),
  ('NVDA', date_trunc('minute', now()), 66, 11, 54, 143, 480,  7.4,  5.9, 0.55, 0.52),
  ('GME',  date_trunc('minute', now()), 58,  9, 33, 132, 310,  9.1, 12.2, 0.64, 0.78)
ON CONFLICT (ticker, bucket_start) DO UPDATE SET
  mentions            = EXCLUDED.mentions,
  posts_count         = EXCLUDED.posts_count,
  unique_authors      = EXCLUDED.unique_authors,
  avg_score           = EXCLUDED.avg_score,
  total_comments      = EXCLUDED.total_comments,
  mention_velocity    = EXCLUDED.mention_velocity,
  abnormality_score   = EXCLUDED.abnormality_score,
  sentiment_score     = EXCLUDED.sentiment_score,
  pump_language_score = EXCLUDED.pump_language_score;
`;

/**
 * Fake alerts. ticker_alerts has no natural conflict key, so we tag every seed
 * row with metrics_snapshot->>'seed' = 'true' and delete those before
 * re-inserting. That keeps reruns from accumulating unbounded duplicates.
 */
const SEED_ALERTS_SQL = /* sql */ `
DELETE FROM public.ticker_alerts
WHERE metrics_snapshot->>'seed' = 'true';

INSERT INTO public.ticker_alerts (ticker, alert_type, severity, metrics_snapshot)
VALUES
  ('RDDT', 'early_narrative',       'medium', jsonb_build_object(
    'seed', true, 'ticker', 'RDDT', 'mentions_1h', 42,
    'abnormality_score', 8.4, 'pump_language_score', 0.25, 'stage', 'early_narrative')),
  ('POET', 'pump_risk',             'high',   jsonb_build_object(
    'seed', true, 'ticker', 'POET', 'mentions_1h', 84,
    'abnormality_score', 26.0, 'pump_language_score', 0.86, 'stage', 'pump_risk')),
  ('MU',   'momentum_confirmation', 'low',    jsonb_build_object(
    'seed', true, 'ticker', 'MU', 'mentions_1h', 31,
    'abnormality_score', 4.1, 'pump_language_score', 0.18, 'stage', 'momentum_confirmation')),
  ('NVDA', 'late_crowded_trade',    'medium', jsonb_build_object(
    'seed', true, 'ticker', 'NVDA', 'mentions_1h', 66,
    'abnormality_score', 5.9, 'pump_language_score', 0.52, 'stage', 'late_crowded_trade')),
  ('GME',  'unusual_mentions',      'high',   jsonb_build_object(
    'seed', true, 'ticker', 'GME', 'mentions_1h', 58,
    'abnormality_score', 12.2, 'pump_language_score', 0.78, 'stage', 'unusual_mentions'));
`;

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();
  const client = new Client({ connectionString });

  try {
    console.log("🔌 Connecting to the database…");
    await client.connect();

    console.log("🌱 Seeding development data (transaction started)…");
    await client.query("BEGIN");

    console.log("  • tickers…");
    await client.query(SEED_TICKERS_SQL);

    console.log("  • reddit_posts…");
    await client.query(SEED_POSTS_SQL);

    console.log("  • ticker_mentions…");
    await client.query(SEED_MENTIONS_SQL);

    console.log("  • ticker_metrics_5m…");
    await client.query(SEED_METRICS_SQL);

    console.log("  • ticker_alerts…");
    await client.query(SEED_ALERTS_SQL);

    await client.query("COMMIT");
    console.log("✅ Seed complete. Development data is ready.");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors — the original error is what matters.
    }
    console.error(
      "❌ Seed failed and was rolled back:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  } finally {
    await client.end();
  }
}

void main();
