/**
 * seedDatabase.ts
 *
 * Seeds deterministic development data for bwsb (YOLOPulse / wsb).
 * All data is FAKE:
 *   - No real Reddit usernames — authors are fake `dev_author_*` hashes.
 *   - Post ids are deterministic `dev_post_*` values.
 *   - Bets use fixed UUIDs so child rows (legs/snapshots) reference them stably.
 *
 * Fully idempotent: ON CONFLICT upserts plus seed-scoped deletes (by deterministic
 * ids / seed markers) mean reruns never accumulate duplicates.
 *
 * SERVER-SIDE ONLY. Reads DATABASE_URL and never logs its value.
 *
 * Usage: npm run db:seed   (run by hand against dev/test databases only)
 */
import "dotenv/config";
import pkg from "pg";

const { Client } = pkg;

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    console.error("❌ DATABASE_URL is not set. Add it to bwsb/.env first.");
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error("❌ DATABASE_URL must start with postgresql:// or postgres://");
    process.exit(1);
  }
  return url;
}

const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";

// Fixed bet UUIDs so legs/snapshots/performance can reference them idempotently.
const BET_IDS = {
  RDDT: "10000000-0000-0000-0000-000000000001",
  POET: "10000000-0000-0000-0000-000000000002",
  MU: "10000000-0000-0000-0000-000000000003",
  NVDA: "10000000-0000-0000-0000-000000000004",
  GME: "10000000-0000-0000-0000-000000000005",
};

const TICKERS_SQL = /* sql */ `
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
  ('ON',   'ON Semiconductor Corp.',      'NASDAQ', true, true),
  ('MSFT', 'Microsoft Corporation',       'NASDAQ', true, false),
  ('AAPL', 'Apple Inc.',                  'NASDAQ', true, false),
  ('META', 'Meta Platforms, Inc.',        'NASDAQ', true, false),
  ('GOOG', 'Alphabet Inc.',               'NASDAQ', true, false),
  ('GOOGL','Alphabet Inc.',               'NASDAQ', true, false),
  ('AMZN', 'Amazon.com, Inc.',            'NASDAQ', true, false),
  ('NFLX', 'Netflix, Inc.',               'NASDAQ', true, false),
  ('CRM',  'Salesforce, Inc.',            'NYSE',   true, false),
  ('NOW',  'ServiceNow, Inc.',            'NYSE',   true, true),
  ('TEAM', 'Atlassian Corporation',       'NASDAQ', true, true)
ON CONFLICT (ticker) DO UPDATE SET
  company_name = EXCLUDED.company_name, exchange = EXCLUDED.exchange,
  is_active = EXCLUDED.is_active, is_common_word = EXCLUDED.is_common_word;
`;

const POSTS_SQL = /* sql */ `
INSERT INTO public.reddit_posts (
  reddit_post_id, subreddit, title, body_excerpt, author_hash,
  score, num_comments, permalink, reddit_created_at
)
VALUES
  ('dev_post_rddt_001','wallstreetbets','RDDT calls before earnings?',
   'Bought 5 RDDT calls strike 180 exp Aug 21 premium 4.20. Mentions picking up. Numbers: rev +21%, guidance raised, source: 10-Q. Risk: crowded.',
   'dev_author_001',128,44,'https://reddit.com/r/wallstreetbets/comments/dev_post_rddt_001', now() - interval '55 minutes'),
  ('dev_post_poet_001','wallstreetbets','POET squeeze incoming or another trap?',
   'POET to the moon!!! easy 10x, everyone buy now, this is the play, loading puts 7.5p 8/21 paid 1.20. guaranteed.',
   'dev_author_002',242,91,'https://reddit.com/r/wallstreetbets/comments/dev_post_poet_001', now() - interval '45 minutes'),
  ('dev_post_mu_001','stocks','MU memory cycle is heating up',
   'Micron HBM narrative. Bought 3 MU calls 150 09/18 premium 7.50. DCF suggests upside, catalyst: earnings, risk disclosed.',
   'dev_author_003',96,32,'https://reddit.com/r/stocks/comments/dev_post_mu_001', now() - interval '35 minutes'),
  ('dev_post_nvda_001','wallstreetbets','NVDA still the king or too crowded?',
   'NVDA mentioned again, might be crowded. bought 2 NVDA calls 200 8/21 @ 8.10. still holding my position.',
   'dev_author_004',310,140,'https://reddit.com/r/wallstreetbets/comments/dev_post_nvda_001', now() - interval '25 minutes'),
  ('dev_post_gme_001','wallstreetbets','GME nostalgia is back',
   'GME calls 35 07/31 20 contracts paid 0.95. diamond hands, yolo, still holding down 40% but averaging down.',
   'dev_author_005',190,77,'https://reddit.com/r/wallstreetbets/comments/dev_post_gme_001', now() - interval '20 minutes'),
  ('dev_post_tsla_001','wallstreetbets','TSLA thinking about calls',
   'thinking about TSLA calls, might buy next week, watching for now. should I?',
   'dev_author_006',75,29,'https://reddit.com/r/wallstreetbets/comments/dev_post_tsla_001', now() - interval '15 minutes'),
  ('dev_post_amc_001','wallstreetbets','AMC bagholders check in',
   'AMC still holding since 2021, down 90%, cant sell now, this is fine. capitulation everywhere.',
   'dev_author_002',54,61,'https://reddit.com/r/wallstreetbets/comments/dev_post_amc_001', now() - interval '10 minutes')
ON CONFLICT (reddit_post_id) DO UPDATE SET
  subreddit=EXCLUDED.subreddit, title=EXCLUDED.title, body_excerpt=EXCLUDED.body_excerpt,
  author_hash=EXCLUDED.author_hash, score=EXCLUDED.score, num_comments=EXCLUDED.num_comments,
  permalink=EXCLUDED.permalink, reddit_created_at=EXCLUDED.reddit_created_at;
`;

const COMMENTS_SQL = /* sql */ `
INSERT INTO public.reddit_comments (
  reddit_comment_id, reddit_post_id, subreddit, author_hash, body_excerpt, score, reddit_created_at
)
VALUES
  ('dev_cmt_rddt_1','dev_post_rddt_001','wallstreetbets','dev_author_010','calls printing, in since 150', 34, now() - interval '50 minutes'),
  ('dev_cmt_poet_1','dev_post_poet_001','wallstreetbets','dev_author_011','this smells like a pump, be careful', 88, now() - interval '40 minutes'),
  ('dev_cmt_poet_2','dev_post_poet_001','wallstreetbets','dev_author_012','buy buy buy 10x incoming', 5, now() - interval '39 minutes'),
  ('dev_cmt_nvda_1','dev_post_nvda_001','wallstreetbets','dev_author_013','too crowded, taking profits', 51, now() - interval '20 minutes'),
  ('dev_cmt_gme_1','dev_post_gme_001','wallstreetbets','dev_author_014','diamond hands never selling', 40, now() - interval '18 minutes')
ON CONFLICT (reddit_comment_id) DO UPDATE SET
  body_excerpt=EXCLUDED.body_excerpt, score=EXCLUDED.score;
`;

const MENTIONS_SQL = /* sql */ `
DELETE FROM public.ticker_mentions WHERE reddit_post_id LIKE 'dev_post_%';
INSERT INTO public.ticker_mentions (ticker, reddit_post_id, pump_language_score, narrative_type)
VALUES
  ('RDDT','dev_post_rddt_001',0.20,'early_narrative'),
  ('POET','dev_post_poet_001',0.85,'pump_risk'),
  ('MU','dev_post_mu_001',0.15,'momentum_confirmation'),
  ('NVDA','dev_post_nvda_001',0.50,'late_crowded_trade'),
  ('GME','dev_post_gme_001',0.75,'meme_revival'),
  ('TSLA','dev_post_tsla_001',0.30,'speculation'),
  ('AMC','dev_post_amc_001',0.40,'bagholder')
ON CONFLICT (ticker, reddit_post_id) DO UPDATE SET
  pump_language_score=EXCLUDED.pump_language_score, narrative_type=EXCLUDED.narrative_type;
`;

const STANCE_SQL = /* sql */ `
DELETE FROM public.ticker_stance_events WHERE reddit_post_id LIKE 'dev_post_%';
INSERT INTO public.ticker_stance_events (ticker, reddit_post_id, author_hash, subreddit, stance, confidence, matched_terms)
VALUES
  ('RDDT','dev_post_rddt_001','dev_author_001','wallstreetbets','bullish',0.80,'["calls","bought"]'),
  ('POET','dev_post_poet_001','dev_author_002','wallstreetbets','bearish',0.65,'["puts","loading"]'),
  ('MU','dev_post_mu_001','dev_author_003','stocks','bullish',0.72,'["calls","upside"]'),
  ('NVDA','dev_post_nvda_001','dev_author_004','wallstreetbets','bullish',0.55,'["calls","holding"]'),
  ('GME','dev_post_gme_001','dev_author_005','wallstreetbets','bullish',0.60,'["calls","diamond hands"]'),
  ('TSLA','dev_post_tsla_001','dev_author_006','wallstreetbets','neutral',0.40,'["thinking","watching"]'),
  ('AMC','dev_post_amc_001','dev_author_002','wallstreetbets','bearish',0.50,'["down","cant sell"]');
`;

const METRICS_5M_SQL = /* sql */ `
INSERT INTO public.ticker_metrics_5m (
  ticker, bucket_start, mentions, posts_count, unique_authors, avg_score,
  total_comments, mention_velocity, abnormality_score, sentiment_score, pump_language_score
)
VALUES
  ('RDDT', date_trunc('minute', now()), 42,  7, 35,  87, 210,  6.2,  8.4, 0.62, 0.25),
  ('POET', date_trunc('minute', now()), 84, 13, 41, 115, 390, 18.5, 26.0, 0.30, 0.86),
  ('MU',   date_trunc('minute', now()), 31,  5, 28,  64, 120,  3.8,  4.1, 0.71, 0.18),
  ('NVDA', date_trunc('minute', now()), 66, 11, 54, 143, 480,  7.4,  5.9, 0.58, 0.52),
  ('GME',  date_trunc('minute', now()), 58,  9, 33, 132, 310,  9.1, 12.2, 0.64, 0.78),
  ('TSLA', date_trunc('minute', now()), 22,  4, 19,  70, 100,  2.1,  2.4, 0.50, 0.30),
  ('AMC',  date_trunc('minute', now()), 18,  3, 12,  48,  90,  1.4,  3.0, 0.35, 0.40)
ON CONFLICT (ticker, bucket_start) DO UPDATE SET
  mentions=EXCLUDED.mentions, posts_count=EXCLUDED.posts_count, unique_authors=EXCLUDED.unique_authors,
  avg_score=EXCLUDED.avg_score, total_comments=EXCLUDED.total_comments,
  mention_velocity=EXCLUDED.mention_velocity, abnormality_score=EXCLUDED.abnormality_score,
  sentiment_score=EXCLUDED.sentiment_score, pump_language_score=EXCLUDED.pump_language_score;
`;

// Daily metrics for the last 14 days per ticker — powers "mentions over time".
const DAILY_METRICS_SQL = /* sql */ `
DELETE FROM public.ticker_daily_metrics WHERE ticker IN ('RDDT','POET','MU','NVDA','GME','TSLA','AMC');
INSERT INTO public.ticker_daily_metrics (ticker, day, mentions, unique_authors, bullish, bearish, neutral, sentiment_score, mention_share)
SELECT t.ticker,
       (current_date - g)::date AS day,
       GREATEST(3, (t.base - g * t.slope + ((g * 7 + length(t.ticker)) % 9)))::int AS mentions,
       GREATEST(2, ((t.base - g * t.slope) / 2))::int AS unique_authors,
       GREATEST(1, ((t.base - g * t.slope) * t.bull / 100))::int AS bullish,
       GREATEST(1, ((t.base - g * t.slope) * (100 - t.bull) / 100))::int AS bearish,
       2 AS neutral,
       t.sent AS sentiment_score,
       LEAST(0.9, GREATEST(0.02, (t.base - g * t.slope)::numeric / 400)) AS mention_share
FROM (VALUES
   ('RDDT', 45, 2, 70, 0.62),
   ('POET', 90, 5, 40, 0.30),
   ('MU',   34, 1, 72, 0.71),
   ('NVDA', 70, 2, 58, 0.58),
   ('GME',  60, 3, 64, 0.64),
   ('TSLA', 25, 1, 50, 0.50),
   ('AMC',  20, 1, 35, 0.35)
 ) AS t(ticker, base, slope, bull, sent)
CROSS JOIN generate_series(0, 13) AS g;
`;

const TREND_CLASS_SQL = /* sql */ `
DELETE FROM public.ticker_trend_classifications WHERE bucket_start >= date_trunc('day', now());
INSERT INTO public.ticker_trend_classifications (ticker, bucket_start, classification, score, rank, evidence)
VALUES
  ('POET', date_trunc('hour', now()), 'most_mentioned',      84, 1, '{"mentions_1h":84}'),
  ('NVDA', date_trunc('hour', now()), 'most_mentioned',      66, 2, '{"mentions_1h":66}'),
  ('GME',  date_trunc('hour', now()), 'most_mentioned',      58, 3, '{"mentions_1h":58}'),
  ('POET', date_trunc('hour', now()), 'acceleration',        18.5, 1, '{"velocity":18.5}'),
  ('GME',  date_trunc('hour', now()), 'acceleration',        9.1, 2, '{"velocity":9.1}'),
  ('RDDT', date_trunc('hour', now()), 'fresh_breakout',      0.71, 1, '{"share_7d":0.71}'),
  ('MU',   date_trunc('hour', now()), 'bullish_pressure',    0.71, 1, '{"sentiment":0.71}'),
  ('RDDT', date_trunc('hour', now()), 'bullish_pressure',    0.62, 2, '{"sentiment":0.62}'),
  ('POET', date_trunc('hour', now()), 'bearish_pressure',    0.30, 1, '{"sentiment":0.30}'),
  ('AMC',  date_trunc('hour', now()), 'bearish_pressure',    0.35, 2, '{"sentiment":0.35}'),
  ('NVDA', date_trunc('hour', now()), 'disagreement',        0.48, 1, '{"bull":0.55,"bear":0.45}'),
  ('POET', date_trunc('hour', now()), 'one_sided_attention', 0.88, 1, '{"one_sided":0.88}'),
  ('POET', date_trunc('hour', now()), 'penny_attention',     0.85, 1, '{"price":4.9}'),
  ('AMC',  date_trunc('hour', now()), 'penny_attention',     0.55, 2, '{"price":3.1}');
`;

const ATTENTION_INDEX_SQL = /* sql */ `
INSERT INTO public.market_attention_indexes (scope, bucket_start, index_value, label, components)
VALUES ('global', date_trunc('hour', now()), 68.4, 'Elevated Retail Attention',
  '{"stance_balance":0.58,"breadth":0.62,"price_confirmation":0.55,"conversation_velocity":0.74,"bet_capital_flow":0.66}')
ON CONFLICT (scope, bucket_start) DO UPDATE SET
  index_value=EXCLUDED.index_value, label=EXCLUDED.label, components=EXCLUDED.components;
`;

const ALERTS_SQL = /* sql */ `
DELETE FROM public.ticker_alerts WHERE metrics_snapshot->>'seed' = 'true';
INSERT INTO public.ticker_alerts (ticker, alert_type, severity, explanation, metrics_snapshot, evidence)
VALUES
  ('POET','possible_coordination','high','Repeated promotional phrases and high author concentration on a low-priced ticker.',
   '{"seed":true}', '{"repeated_phrases":["to the moon","easy 10x","buy now"],"author_concentration":0.62,"new_account_ratio":0.35,"deletion_rate":0.18}'),
  ('RDDT','declared_call_capital_spike','medium','Declared call premium at risk rose sharply in the last hour.',
   '{"seed":true}', '{"declared_call_capital":21000,"window":"1h","delta_pct":180}'),
  ('POET','declared_put_capital_spike','medium','Declared put premium building against the crowd.',
   '{"seed":true}', '{"declared_put_capital":12000,"window":"1h"}'),
  ('MU','verified_bets_cluster','low','Multiple internally-consistent bets clustered around the 150 strike.',
   '{"seed":true}', '{"cluster_strike":150,"verified_bets":3}'),
  ('NVDA','smart_authors_against_crowd','medium','Higher-reputation authors are fading a crowded bullish tape.',
   '{"seed":true}', '{"smart_authors":4,"crowd_stance":"bullish"}'),
  ('GME','expiration_wall_this_week','high','Large contract concentration expiring 07/31.',
   '{"seed":true}', '{"expiration":"2026-07-31","contracts":20}'),
  ('AMC','bullish_sentiment_negative_collective_pl','medium','Conversation stays bullish while collective P/L is deeply negative.',
   '{"seed":true}', '{"sentiment":0.35,"collective_pl_pct":-38}');
`;

// Anonymized authors + resolved signal history (for smart-early detection).
const AUTHORS_SQL = /* sql */ `
INSERT INTO public.anonymized_authors (author_hash, account_age_days, posts_count, resolved_signals, hit_rate, reputation_score, is_new_account)
VALUES
  ('dev_author_001', 1450, 320, 41, 0.68, 74.0, false),
  ('dev_author_002',   28,  90, 12, 0.33, 22.0, true),
  ('dev_author_003', 2100, 510, 63, 0.71, 81.0, false),
  ('dev_author_004',  900, 210, 30, 0.57, 55.0, false),
  ('dev_author_005', 1200, 260, 25, 0.60, 58.0, false),
  ('dev_author_006',   40,  15,  3, 0.33, 18.0, true)
ON CONFLICT (author_hash) DO UPDATE SET
  account_age_days=EXCLUDED.account_age_days, posts_count=EXCLUDED.posts_count,
  resolved_signals=EXCLUDED.resolved_signals, hit_rate=EXCLUDED.hit_rate,
  reputation_score=EXCLUDED.reputation_score, is_new_account=EXCLUDED.is_new_account;

DELETE FROM public.author_signal_history WHERE author_hash LIKE 'dev_author_%';
INSERT INTO public.author_signal_history (author_hash, ticker, signal_type, stance, signaled_at, resolved_at, outcome, return_pct, was_early)
VALUES
  ('dev_author_003','MU','early_mention','bullish', now() - interval '9 days', now() - interval '2 days','win', 22.5, true),
  ('dev_author_001','RDDT','early_mention','bullish', now() - interval '6 days', now() - interval '1 days','win', 14.0, true),
  ('dev_author_004','NVDA','crowd_mention','bullish', now() - interval '5 days', now() - interval '1 days','loss', -6.0, false),
  ('dev_author_002','POET','pump_mention','bullish', now() - interval '3 days', NULL, NULL, NULL, false);
`;

// Market / options / short interest / news / insiders / catalysts (stub sources).
const MARKET_SQL = /* sql */ `
INSERT INTO public.market_snapshots (ticker, snapshot_at, price, change_pct, volume, avg_volume, market_cap, beta, source, metadata)
VALUES
  ('RDDT', date_trunc('day', now()), 178.40,  2.1,  9200000, 8100000, 30000000000, 1.35, 'stub','{"seed":true}'),
  ('POET', date_trunc('day', now()),   4.90,  8.6, 15000000, 6000000,   250000000, 2.40, 'stub','{"seed":true}'),
  ('MU',   date_trunc('day', now()), 146.20,  1.3, 18000000,20000000,160000000000, 1.15, 'stub','{"seed":true}'),
  ('NVDA', date_trunc('day', now()), 197.10, -0.8, 41000000,45000000,2000000000000,1.60,'stub','{"seed":true}'),
  ('GME',  date_trunc('day', now()),  33.10,  5.4, 12000000, 7000000,  14000000000, 1.80, 'stub','{"seed":true}'),
  ('TSLA', date_trunc('day', now()), 312.50,  0.4, 30000000,32000000, 990000000000, 2.00, 'stub','{"seed":true}'),
  ('AMC',  date_trunc('day', now()),   3.10, -3.2, 20000000,10000000,   1500000000, 2.10, 'stub','{"seed":true}')
ON CONFLICT (ticker, snapshot_at) DO UPDATE SET
  price=EXCLUDED.price, change_pct=EXCLUDED.change_pct, volume=EXCLUDED.volume,
  avg_volume=EXCLUDED.avg_volume, market_cap=EXCLUDED.market_cap, beta=EXCLUDED.beta;

DELETE FROM public.option_chain_snapshots WHERE source = 'stub';
WITH chain AS (
  INSERT INTO public.option_chain_snapshots (ticker, snapshot_at, expiration_date, source, metadata)
  VALUES
    ('RDDT', date_trunc('day', now()), date '2026-08-21', 'stub', '{"seed":true}'),
    ('POET', date_trunc('day', now()), date '2026-08-21', 'stub', '{"seed":true}'),
    ('NVDA', date_trunc('day', now()), date '2026-08-21', 'stub', '{"seed":true}')
  RETURNING id, ticker
)
INSERT INTO public.option_contract_snapshots
  (chain_snapshot_id, ticker, option_type, strike, expiration_date, bid, ask, mid, last, volume, open_interest, implied_volatility, delta, gamma, theta, vega)
SELECT c.id, c.ticker, 'call', 180, date '2026-08-21', 4.10, 4.30, 4.20, 4.20, 3200, 8100, 0.62, 0.48, 0.02, -0.05, 0.18
FROM chain c WHERE c.ticker='RDDT'
UNION ALL SELECT c.id, c.ticker, 'put', 7.5, date '2026-08-21', 1.15, 1.25, 1.20, 1.20, 900, 2400, 0.95, -0.42, 0.03, -0.04, 0.10
FROM chain c WHERE c.ticker='POET'
UNION ALL SELECT c.id, c.ticker, 'call', 200, date '2026-08-21', 8.00, 8.20, 8.10, 8.10, 5400, 12000, 0.55, 0.45, 0.01, -0.07, 0.22
FROM chain c WHERE c.ticker='NVDA';

DELETE FROM public.short_interest_snapshots WHERE source = 'stub';
INSERT INTO public.short_interest_snapshots (ticker, snapshot_at, short_interest, short_percent_float, days_to_cover, borrow_fee, squeeze_risk_score, source, metadata)
VALUES
  ('GME', date_trunc('day', now()), 45000000, 0.22, 3.1, 0.08, 72, 'stub','{"seed":true}'),
  ('AMC', date_trunc('day', now()), 60000000, 0.18, 2.4, 0.15, 61, 'stub','{"seed":true}'),
  ('POET',date_trunc('day', now()), 12000000, 0.28, 4.0, 0.22, 66, 'stub','{"seed":true}');

DELETE FROM public.news_events WHERE source = 'stub';
INSERT INTO public.news_events (ticker, headline, url, source, sentiment, published_at, metadata)
VALUES
  ('RDDT','Reddit beats revenue estimates, raises guidance','https://example.com/rddt','stub', 0.6, now() - interval '2 days','{"seed":true}'),
  ('NVDA','Analysts debate whether NVDA rally is overextended','https://example.com/nvda','stub', -0.1, now() - interval '1 days','{"seed":true}'),
  ('MU','Memory pricing firms up on HBM demand','https://example.com/mu','stub', 0.5, now() - interval '3 days','{"seed":true}');

DELETE FROM public.insider_activity_events WHERE source = 'stub';
INSERT INTO public.insider_activity_events (ticker, insider_role, transaction_type, shares, value, filed_at, source, metadata)
VALUES
  ('RDDT','CFO','sell', 25000, 4400000, now() - interval '4 days','stub','{"seed":true}'),
  ('MU','Director','buy', 10000, 1460000, now() - interval '6 days','stub','{"seed":true}');

DELETE FROM public.external_social_snapshots WHERE platform = 'stub';
INSERT INTO public.external_social_snapshots (ticker, platform, snapshot_at, mentions, sentiment, metadata)
VALUES
  ('RDDT','stub', date_trunc('day', now()), 1200, 0.55, '{"seed":true}'),
  ('POET','stub', date_trunc('day', now()), 3400, 0.20, '{"seed":true}'),
  ('GME','stub', date_trunc('day', now()), 2100, 0.60, '{"seed":true}');

DELETE FROM public.catalyst_events WHERE metadata->>'seed' = 'true';
INSERT INTO public.catalyst_events (ticker, catalyst_type, title, event_date, confirmed, metadata)
VALUES
  ('RDDT','earnings','RDDT Q2 earnings', date '2026-08-05', true, '{"seed":true}'),
  ('MU','earnings','MU fiscal Q4 earnings', date '2026-09-25', true, '{"seed":true}'),
  ('NVDA','product','NVDA GTC keynote', date '2026-08-18', false, '{"seed":true}');
`;

// Bets (fixed UUIDs) + legs + child rows.
const BETS_SQL = /* sql */ `
INSERT INTO public.bets (id, source_type, reddit_post_id, author_hash, ticker, direction, instrument, option_type,
  position_intent, status, declared_capital, verified_capital, notional_exposure, max_loss, max_gain, breakeven,
  entry_underlying_price, entry_timestamp, extraction_confidence, verification_level, raw_evidence, metadata)
VALUES
  ('${BET_IDS.RDDT}','reddit','dev_post_rddt_001','dev_author_001','RDDT','bullish','option','call',
   'real_position','open', 2100, 2100, 90000, 2100, NULL, 184.20, 176.00, now() - interval '55 minutes', 0.86,'internally_consistent',
   '{"text":"bought 5 RDDT calls strike 180 exp Aug 21 premium 4.20"}','{"seed":true}'),
  ('${BET_IDS.POET}','reddit','dev_post_poet_001','dev_author_002','POET','bearish','option','put',
   'real_position','open', 1200, 0, 7500, 1200, NULL, 6.30, 5.10, now() - interval '45 minutes', 0.74,'text_only',
   '{"text":"loading puts 7.5p 8/21 paid 1.20"}','{"seed":true}'),
  ('${BET_IDS.MU}','reddit','dev_post_mu_001','dev_author_003','MU','bullish','option','call',
   'real_position','open', 2250, 2250, 45000, 2250, NULL, 157.50, 144.00, now() - interval '35 minutes', 0.82,'market_validated',
   '{"text":"bought 3 MU calls 150 09/18 premium 7.50"}','{"seed":true}'),
  ('${BET_IDS.NVDA}','reddit','dev_post_nvda_001','dev_author_004','NVDA','bullish','option','call',
   'real_position','open', 1620, 1620, 40000, 1620, NULL, 208.10, 195.00, now() - interval '25 minutes', 0.80,'internally_consistent',
   '{"text":"bought 2 NVDA calls 200 8/21 @ 8.10"}','{"seed":true}'),
  ('${BET_IDS.GME}','reddit','dev_post_gme_001','dev_author_005','GME','bullish','option','call',
   'real_position','open', 1900, 0, 70000, 1900, NULL, 35.95, 31.40, now() - interval '20 minutes', 0.77,'screenshot_detected',
   '{"text":"GME calls 35 07/31 20 contracts paid 0.95"}','{"seed":true}')
ON CONFLICT (id) DO UPDATE SET
  declared_capital=EXCLUDED.declared_capital, verified_capital=EXCLUDED.verified_capital,
  verification_level=EXCLUDED.verification_level, extraction_confidence=EXCLUDED.extraction_confidence,
  status=EXCLUDED.status, updated_at=now();

DELETE FROM public.bet_legs WHERE bet_id IN ('${BET_IDS.RDDT}','${BET_IDS.POET}','${BET_IDS.MU}','${BET_IDS.NVDA}','${BET_IDS.GME}');
INSERT INTO public.bet_legs (bet_id, leg_type, side, option_type, strike, expiration_date, contracts, premium, price, dte, moneyness, delta, implied_volatility, bid, ask, mid)
VALUES
  ('${BET_IDS.RDDT}','option','long','call', 180, date '2026-08-21', 5, 4.20, 4.20, 33,'OTM', 0.48, 0.62, 4.10, 4.30, 4.20),
  ('${BET_IDS.POET}','option','long','put',  7.5, date '2026-08-21',10, 1.20, 1.20, 33,'ITM',-0.42, 0.95, 1.15, 1.25, 1.20),
  ('${BET_IDS.MU}','option','long','call',   150,date '2026-09-18', 3, 7.50, 7.50, 61,'OTM', 0.44, 0.58, 7.40, 7.60, 7.50),
  ('${BET_IDS.NVDA}','option','long','call', 200,date '2026-08-21', 2, 8.10, 8.10, 33,'OTM', 0.45, 0.55, 8.00, 8.20, 8.10),
  ('${BET_IDS.GME}','option','long','call',  35, date '2026-07-31',20, 0.95, 0.95, 12,'OTM', 0.30, 0.90, 0.90, 1.00, 0.95);

DELETE FROM public.bet_snapshots WHERE bet_id IN ('${BET_IDS.RDDT}','${BET_IDS.POET}','${BET_IDS.MU}','${BET_IDS.NVDA}','${BET_IDS.GME}');
INSERT INTO public.bet_snapshots (bet_id, snapshot_at, underlying_price, estimated_option_value, estimated_position_value, return_pct, unrealized_pl, max_gain_so_far, max_loss_so_far, metadata)
VALUES
  ('${BET_IDS.RDDT}', now(), 178.40, 5.10, 2550,  21.4,  450,  520, -120, '{"seed":true}'),
  ('${BET_IDS.POET}', now(),   4.90, 2.70, 2700, 125.0, 1500, 1500,  -80, '{"seed":true}'),
  ('${BET_IDS.MU}',   now(), 146.20, 6.90, 2070,  -8.0, -180,  120, -300, '{"seed":true}'),
  ('${BET_IDS.NVDA}', now(), 197.10, 7.40, 1480,  -8.6, -140,  160, -220, '{"seed":true}'),
  ('${BET_IDS.GME}',  now(),  33.10, 0.70, 1400, -26.3, -500,  300, -520, '{"seed":true}');

DELETE FROM public.bet_verifications WHERE bet_id IN ('${BET_IDS.RDDT}','${BET_IDS.POET}','${BET_IDS.MU}','${BET_IDS.NVDA}','${BET_IDS.GME}');
INSERT INTO public.bet_verifications (bet_id, verification_level, method, passed, detail)
VALUES
  ('${BET_IDS.RDDT}','internally_consistent','premium_vs_chain', true, '{"expected":4.20,"observed":4.20}'),
  ('${BET_IDS.MU}','market_validated','chain_lookup', true, '{"strike_found":true}'),
  ('${BET_IDS.GME}','screenshot_detected','ocr_stub', true, '{"attachment":"screenshot"}');

DELETE FROM public.bet_lifecycle_events WHERE bet_id IN ('${BET_IDS.RDDT}','${BET_IDS.POET}','${BET_IDS.MU}','${BET_IDS.NVDA}','${BET_IDS.GME}');
INSERT INTO public.bet_lifecycle_events (bet_id, event_type, detail, occurred_at)
VALUES
  ('${BET_IDS.RDDT}','opened','{"note":"initial position"}', now() - interval '55 minutes'),
  ('${BET_IDS.RDDT}','snapshot','{"return_pct":21.4}', now()),
  ('${BET_IDS.POET}','opened','{"note":"put entry"}', now() - interval '45 minutes'),
  ('${BET_IDS.GME}','opened','{"note":"lotto calls"}', now() - interval '20 minutes');

DELETE FROM public.bet_performance WHERE bet_id IN ('${BET_IDS.RDDT}','${BET_IDS.POET}','${BET_IDS.MU}','${BET_IDS.NVDA}','${BET_IDS.GME}');
INSERT INTO public.bet_performance (bet_id, ticker, realized_return_pct, peak_return_pct, trough_return_pct, outcome, spy_adjusted_return, early_late_score, resolved_at, metadata)
VALUES
  ('${BET_IDS.RDDT}','RDDT', 21.4, 30.0, -12.0, 'winning', 18.0, 0.80, NULL, '{"seed":true}'),
  ('${BET_IDS.POET}','POET', 125.0,140.0,  -8.0, 'winning', 122.0, 0.65, NULL, '{"seed":true}'),
  ('${BET_IDS.MU}','MU',    -8.0, 12.0, -30.0, 'losing', -11.0, 0.55, NULL, '{"seed":true}'),
  ('${BET_IDS.NVDA}','NVDA', -8.6, 16.0, -22.0, 'losing', -12.0, 0.40, NULL, '{"seed":true}'),
  ('${BET_IDS.GME}','GME',  -26.3, 30.0, -52.0, 'losing', -30.0, 0.35, NULL, '{"seed":true}');
`;

// Analytics/scoring outputs.
const ANALYTICS_SQL = /* sql */ `
INSERT INTO public.signal_scores (ticker, bucket_start, signal_type, score, confidence, explanation, evidence)
VALUES
  ('RDDT', date_trunc('hour', now()), 'direction_1h', 62, 0.60, 'Bullish call flow and rising mentions.', '{"mentions":42,"calls":5}'),
  ('RDDT', date_trunc('hour', now()), 'direction_24h',58, 0.55, 'Sustained bullish attention over 24h.', '{"mentions_24h":320}'),
  ('POET', date_trunc('hour', now()), 'pump_risk',    85, 0.70, 'Coordinated promotional language on a penny name.', '{"phrases":3}'),
  ('NVDA', date_trunc('hour', now()), 'contrarian',   54, 0.45, 'Crowded bullish tape; contrarian signal weak, low confidence.', '{"call_ratio":0.78,"sample":66}'),
  ('MU', date_trunc('hour', now()), 'direction_1h',   66, 0.62, 'Bullish momentum confirmation with real bets.', '{"verified_bets":1}')
ON CONFLICT (ticker, bucket_start, signal_type) DO UPDATE SET
  score=EXCLUDED.score, confidence=EXCLUDED.confidence, explanation=EXCLUDED.explanation, evidence=EXCLUDED.evidence;

INSERT INTO public.ticker_positioning_indexes (ticker, bucket_start, call_conviction, put_conviction,
  net_directional_conviction, declared_yolo_capital, verified_yolo_capital, average_dte, average_moneyness, premium_at_risk, leveraged_sentiment, expiration_wall)
VALUES
  ('RDDT', date_trunc('hour', now()), 0.78, 0.10, 0.68, 21000, 18000, 33, 0.48, 21000, 0.66, '{"2026-08-21":21000}'),
  ('POET', date_trunc('hour', now()), 0.15, 0.72, -0.57, 12000, 0, 33, 0.42, 12000, -0.50, '{"2026-08-21":12000}'),
  ('MU',   date_trunc('hour', now()), 0.70, 0.12, 0.58, 9000, 9000, 61, 0.44, 9000, 0.55, '{"2026-09-18":9000}'),
  ('NVDA', date_trunc('hour', now()), 0.66, 0.20, 0.46, 16000, 12000, 33, 0.45, 16000, 0.40, '{"2026-08-21":16000}'),
  ('GME',  date_trunc('hour', now()), 0.80, 0.05, 0.75, 19000, 0, 12, 0.30, 19000, 0.60, '{"2026-07-31":19000}')
ON CONFLICT (ticker, bucket_start) DO UPDATE SET
  call_conviction=EXCLUDED.call_conviction, put_conviction=EXCLUDED.put_conviction,
  net_directional_conviction=EXCLUDED.net_directional_conviction, declared_yolo_capital=EXCLUDED.declared_yolo_capital,
  verified_yolo_capital=EXCLUDED.verified_yolo_capital, average_dte=EXCLUDED.average_dte,
  premium_at_risk=EXCLUDED.premium_at_risk, leveraged_sentiment=EXCLUDED.leveraged_sentiment, expiration_wall=EXCLUDED.expiration_wall;

INSERT INTO public.pump_coordination_scores (ticker, bucket_start, score, severity, repeated_phrases, author_concentration, new_account_ratio, cross_subreddit_activity, deletion_rate, explanation)
VALUES
  ('POET', date_trunc('hour', now()), 85, 'high', '["to the moon","easy 10x","buy now"]', 0.62, 0.35, '{"subreddits":["wallstreetbets","pennystocks"]}', 0.18, 'Repeated promotional phrases, concentrated authors, new accounts, and deletions.'),
  ('GME',  date_trunc('hour', now()), 40, 'medium','["diamond hands"]', 0.30, 0.10, '{"subreddits":["wallstreetbets"]}', 0.05, 'Some repetition but organic meme revival.')
ON CONFLICT (ticker, bucket_start) DO UPDATE SET
  score=EXCLUDED.score, severity=EXCLUDED.severity, repeated_phrases=EXCLUDED.repeated_phrases,
  author_concentration=EXCLUDED.author_concentration, new_account_ratio=EXCLUDED.new_account_ratio,
  deletion_rate=EXCLUDED.deletion_rate, explanation=EXCLUDED.explanation;

INSERT INTO public.dd_quality_scores (reddit_post_id, ticker, score, evidence_score, source_score, calculation_score, catalyst_score, risk_disclosure_score, originality_score, category, explanation)
VALUES
  ('dev_post_rddt_001','RDDT', 78, 0.8, 0.7, 0.8, 0.9, 0.7, 0.6, 'high_quality','Numbers, source (10-Q), catalyst, and risk disclosed.'),
  ('dev_post_mu_001','MU', 72, 0.7, 0.6, 0.9, 0.8, 0.7, 0.6, 'high_quality','DCF, catalyst, risk disclosed.'),
  ('dev_post_poet_001','POET', 14, 0.1, 0.0, 0.0, 0.1, 0.0, 0.1, 'low_quality','Hype only, no numbers, no sources, no risk disclosure.')
ON CONFLICT (reddit_post_id) DO UPDATE SET
  score=EXCLUDED.score, category=EXCLUDED.category, explanation=EXCLUDED.explanation;

DELETE FROM public.narrative_events WHERE metadata->>'seed' = 'true';
INSERT INTO public.narrative_events (ticker, narrative, narrative_type, strength, metadata)
VALUES
  ('RDDT','Earnings beat and guidance raise','fundamental', 0.7, '{"seed":true}'),
  ('MU','HBM / memory super-cycle','fundamental', 0.8, '{"seed":true}'),
  ('POET','Imminent short squeeze','speculative', 0.6, '{"seed":true}'),
  ('GME','Meme revival','meme', 0.5, '{"seed":true}');

DELETE FROM public.narrative_transitions WHERE metadata->>'seed' = 'true';
INSERT INTO public.narrative_transitions (ticker, from_narrative, to_narrative, confidence, metadata)
VALUES
  ('NVDA','AI leader','Too crowded / profit taking', 0.55, '{"seed":true}'),
  ('POET','Turnaround story','Pump and dump risk', 0.6, '{"seed":true}');

DELETE FROM public.beta_adjusted_results WHERE signal_ref LIKE 'seed_%';
INSERT INTO public.beta_adjusted_results (ticker, signal_ref, window_days, raw_return, spy_return, beta, beta_adjusted_return)
VALUES
  ('RDDT','seed_rddt', 7, 14.0, 1.2, 1.35, 12.4),
  ('MU','seed_mu', 14, 22.5, 2.0, 1.15, 20.2),
  ('NVDA','seed_nvda', 7, -6.0, 1.0, 1.60, -7.6);
`;

const BACKTEST_SQL = /* sql */ `
DELETE FROM public.backtest_runs WHERE query->>'seed' = 'true';
WITH run AS (
  INSERT INTO public.backtest_runs (name, query)
  VALUES ('Verified bullish call bets, 7d hold', '{"seed":true,"filters":{"direction":"bullish","instrument":"option","min_verification":"internally_consistent"},"hold_days":7}')
  RETURNING id
)
INSERT INTO public.backtest_results (backtest_run_id, observations, win_rate, median_return, average_return, max_drawdown, spy_adjusted_return, option_estimated_return, result_distribution)
SELECT run.id, 128, 0.54, 6.2, 11.8, -42.0, 8.9, 34.5,
  '{"buckets":[{"range":"-100..-50","n":22},{"range":"-50..0","n":34},{"range":"0..50","n":48},{"range":"50..200","n":24}]}'
FROM run;
`;

const RESEARCH_SQL = /* sql */ `
INSERT INTO public.research_reports (slug, title, summary, body, report_type, tickers, metadata)
VALUES
  ('weekly-retail-bet-recap','Weekly Retail Bet Recap',
   'Where retail actually put money this week, not just what they talked about.',
   E'# Weekly Retail Bet Recap\\n\\nDeclared call capital concentrated in RDDT and NVDA. POET showed pump-coordination red flags. Verified bets skew bullish with a 54% historical win rate on the 7-day hold.\\n\\n*Signals are informational only, not investment advice.*',
   'weekly_recap', '["RDDT","NVDA","POET"]', '{"seed":true}'),
  ('wsb-vs-real-results','Retail vs Real Results',
   'How closely did realized option outcomes track the crowd''s conviction?',
   E'# Retail vs Real Results\\n\\nHigh-conviction bullish positioning modestly outperformed SPY on a beta-adjusted basis, but penny-name hype (POET) underperformed once coordination faded.\\n\\n*Signals are informational only, not investment advice.*',
   'analysis', '["RDDT","MU","POET","GME"]', '{"seed":true}')
ON CONFLICT (slug) DO UPDATE SET
  title=EXCLUDED.title, summary=EXCLUDED.summary, body=EXCLUDED.body, tickers=EXCLUDED.tickers;
`;

const PRODUCT_SQL = /* sql */ `
INSERT INTO public.user_watchlists (id, user_id, name)
VALUES ('30000000-0000-0000-0000-000000000001', '${DEMO_USER_ID}', 'My Watchlist')
ON CONFLICT (user_id, name) DO NOTHING;

INSERT INTO public.user_watchlist_items (watchlist_id, ticker)
VALUES
  ('30000000-0000-0000-0000-000000000001','RDDT'),
  ('30000000-0000-0000-0000-000000000001','MU'),
  ('30000000-0000-0000-0000-000000000001','GME')
ON CONFLICT (watchlist_id, ticker) DO NOTHING;

DELETE FROM public.user_portfolio_positions WHERE user_id = '${DEMO_USER_ID}';
INSERT INTO public.user_portfolio_positions (user_id, ticker, quantity, avg_cost, instrument, opened_at, metadata)
VALUES
  ('${DEMO_USER_ID}','RDDT', 30, 150.00, 'stock', now() - interval '30 days', '{"linked_signal":"direction_1h"}'),
  ('${DEMO_USER_ID}','MU',   20, 130.00, 'stock', now() - interval '20 days', '{"linked_signal":"direction_1h"}'),
  ('${DEMO_USER_ID}','GME',  50,  28.00, 'stock', now() - interval '60 days', '{"linked_signal":"pump_risk"}');

DELETE FROM public.user_alert_rules WHERE user_id = '${DEMO_USER_ID}';
INSERT INTO public.user_alert_rules (user_id, name, rule_type, ticker, params, is_active)
VALUES
  ('${DEMO_USER_ID}','POET pump watch','possible_coordination','POET','{"min_score":70}', true),
  ('${DEMO_USER_ID}','RDDT call capital','declared_call_capital_spike','RDDT','{"min_delta_pct":100}', true);

INSERT INTO public.daily_summaries (user_id, day, summary, highlights)
VALUES ('${DEMO_USER_ID}', current_date,
  'Retail leaned bullish today. RDDT and MU led verified call capital; POET flashed coordination risk.',
  '["RDDT verified call capital up","POET possible coordination (high)","GME expiration wall 07/31"]')
ON CONFLICT (user_id, day) DO UPDATE SET summary=EXCLUDED.summary, highlights=EXCLUDED.highlights;

DELETE FROM public.webhook_subscriptions WHERE user_id = '${DEMO_USER_ID}';
INSERT INTO public.webhook_subscriptions (user_id, target_url, event_types, is_active)
VALUES ('${DEMO_USER_ID}','https://example.com/webhooks/yolopulse','["alert.created","bet.verified"]', true);
`;

// One demo competition for the paper-trading league. Fixed id keeps it
// idempotent. No real users are created — participants join at runtime.
const COMPETITION_SQL = /* sql */ `
INSERT INTO public.competitions (id, name, description, starting_cash, is_active, starts_at, ends_at)
VALUES (
  '40000000-0000-0000-0000-000000000001',
  'YOLOPulse Paper Trading League',
  'Virtual trading only. No real money. Compete on paper-trading returns against other YOLOPulse users.',
  100000, true, now() - interval '7 days', now() + interval '30 days'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description,
  starting_cash = EXCLUDED.starting_cash, is_active = EXCLUDED.is_active;
`;

async function main(): Promise<void> {
  const client = new Client({ connectionString: getDatabaseUrl() });
  const steps: Array<[string, string]> = [
    ["tickers", TICKERS_SQL],
    ["reddit_posts", POSTS_SQL],
    ["reddit_comments", COMMENTS_SQL],
    ["ticker_mentions", MENTIONS_SQL],
    ["ticker_stance_events", STANCE_SQL],
    ["ticker_metrics_5m", METRICS_5M_SQL],
    ["ticker_daily_metrics", DAILY_METRICS_SQL],
    ["ticker_trend_classifications", TREND_CLASS_SQL],
    ["market_attention_indexes", ATTENTION_INDEX_SQL],
    ["ticker_alerts", ALERTS_SQL],
    ["authors", AUTHORS_SQL],
    ["market data", MARKET_SQL],
    ["bets", BETS_SQL],
    ["analytics/scoring", ANALYTICS_SQL],
    ["backtests", BACKTEST_SQL],
    ["research_reports", RESEARCH_SQL],
    ["product/user demo data", PRODUCT_SQL],
    ["demo competition", COMPETITION_SQL],
  ];

  try {
    console.log("🔌 Connecting to the database…");
    await client.connect();

    console.log("🌱 Seeding development data (transaction started)…");
    await client.query("BEGIN");
    for (const [label, sql] of steps) {
      console.log(`  • ${label}…`);
      await client.query(sql);
    }
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
