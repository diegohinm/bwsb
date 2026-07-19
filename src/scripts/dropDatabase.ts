/**
 * dropDatabase.ts
 *
 * Drops all StonkTerminal / wsb project tables so `db:reset` can rebuild them
 * from scratch. CASCADE takes care of foreign-key dependencies.
 *
 * The auth tables `users` and `session` are intentionally PRESERVED — dropping
 * them would destroy user accounts and log everyone out. `db:setup` re-creates
 * `users` with IF NOT EXISTS regardless.
 *
 * SERVER-SIDE ONLY. Reads DATABASE_URL and never logs its value.
 */
import "dotenv/config";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("Missing DATABASE_URL in .env");
  process.exit(1);
}

if (
  !databaseUrl.startsWith("postgresql://") &&
  !databaseUrl.startsWith("postgres://")
) {
  console.error(
    "Invalid DATABASE_URL. It must start with postgresql:// or postgres://",
  );
  process.exit(1);
}

// Every project table except the auth tables (users, session).
const TABLES = [
  // H. personal / signed-in features
  "competition_leaderboard_snapshots",
  "competition_participants",
  "competitions",
  "virtual_positions",
  "virtual_trades",
  "virtual_accounts",
  "user_notifications",
  // G. product/user
  "api_usage_events",
  "daily_summaries",
  "webhook_subscriptions",
  "user_alert_deliveries",
  "user_alert_rules",
  "user_portfolio_positions",
  "user_watchlist_items",
  "user_watchlists",
  // F. analytics/scoring
  "research_reports",
  "backtest_results",
  "backtest_runs",
  "beta_adjusted_results",
  "narrative_transitions",
  "narrative_events",
  "dd_quality_scores",
  "pump_coordination_scores",
  "ticker_positioning_indexes",
  "signal_scores",
  // E. market data
  "catalyst_events",
  "external_social_snapshots",
  "insider_activity_events",
  "news_events",
  "short_interest_snapshots",
  "option_contract_snapshots",
  "option_chain_snapshots",
  "market_snapshots",
  // D. author intelligence
  "author_signal_history",
  "author_reputation_snapshots",
  "anonymized_authors",
  // C. bet intelligence
  "bet_extraction_errors",
  "bet_performance",
  "bet_lifecycle_events",
  "bet_verifications",
  "bet_snapshots",
  "bet_legs",
  "bets",
  // B. mention/sentiment
  "market_attention_indexes",
  "ticker_trend_classifications",
  "ticker_daily_metrics",
  "subreddit_ticker_metrics_1h",
  "subreddit_ticker_metrics_5m",
  "ticker_stance_events",
  // A. raw/content
  "deleted_or_changed_content_events",
  "post_snapshots",
  "reddit_attachments",
  "reddit_comments",
  // existing core
  "ticker_alerts",
  "ticker_metrics_5m",
  "ticker_mentions",
  "reddit_posts",
  "tickers",
];

const dropSql = TABLES.map(
  (t) => `drop table if exists public.${t} cascade;`,
).join("\n");

async function main() {
  const client = new Client({ connectionString: databaseUrl });

  try {
    console.log("Connecting to database...");
    await client.connect();

    console.log("Dropping StonkTerminal / wsb project tables...");
    await client.query("begin");
    await client.query(dropSql);
    await client.query("commit");

    console.log("Database tables dropped successfully.");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    console.error("Failed to drop database tables:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
