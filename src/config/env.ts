import "dotenv/config";
import { z } from "zod";

/**
 * Schema for all environment variables the backend depends on.
 * Server-side only — never expose these values to the frontend.
 *
 * Auth model:
 *  - PRIMARY auth is email + password (see services/auth/*). It needs only the
 *    database, a session secret and (optionally) SMTP.
 *  - Reddit OAuth is OPTIONAL and disabled until fully configured. Its env vars
 *    are therefore all optional and the app starts fine without them. Use
 *    `isRedditOAuthConfigured` to decide whether the OAuth routes are live.
 *
 * Notes on the two "database" URLs:
 *  - DATABASE_URL is a PostgreSQL connection string used by Prisma, the raw pg
 *    pool and the auth tables. This is the app's own database.
 *  - SUPABASE_URL is the Supabase REST endpoint used by the tickers feature.
 */

/** Placeholder values that must be treated as "not configured". */
const REDDIT_ID_PLACEHOLDER = "your_reddit_client_id";
const REDDIT_SECRET_PLACEHOLDER = "your_reddit_client_secret";
const GOOGLE_ID_PLACEHOLDER = "your_google_client_id";
const GOOGLE_SECRET_PLACEHOLDER = "your_google_client_secret";

const boolFromString = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return fallback;
      return v.trim().toLowerCase() === "true" || v.trim() === "1";
    });

const optionalNonEmpty = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

/**
 * Integer env var with a safe fallback. A missing, blank or unparseable value
 * yields `fallback` instead of failing startup, and the result is clamped to
 * `min`/`max` — an operator typo can never turn into an unbounded request rate.
 */
const intEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return fallback;
      const n = Number(v.trim());
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(n)));
    });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /**
   * Which process this is. The deployment runs TWO services from this repo:
   *   api    → src/server.ts. Serves HTTP, reads DB/cache ONLY. Never calls
   *            Mindcase or Databento on a user request.
   *   worker → src/worker.ts. Runs the ingestion jobs, calls the providers,
   *            writes snapshots to the DB. Exposes no HTTP.
   *   all    → single-process local development (default): the API also allows
   *            provider calls, so `npm run dev` alone still works.
   */
  SERVICE_ROLE: z.enum(["api", "worker", "all"]).default("all"),

  // Public origin of the frontend, and the ONLY allowed CORS origin.
  //
  // Both spellings are accepted as INPUT: FRONTEND_ORIGIN is the schema name,
  // FRONTEND_URL is what most hosting guides (and Render's own docs) call it.
  // Reading only one while an operator sets the other is silent
  // misconfiguration that surfaces as a CORS failure in production.
  FRONTEND_ORIGIN: optionalNonEmpty,
  FRONTEND_URL: optionalNonEmpty,
  BACKEND_URL: z.string().url().default("http://localhost:4000"),

  // App database (Prisma + raw pg pool + session/auth tables).
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, {
      message: "DATABASE_URL must be a postgres:// or postgresql:// URL",
    }),

  // Supabase REST client (existing tickers feature).
  SUPABASE_URL: z.string().url({ message: "SUPABASE_URL must be a valid URL" }),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, { message: "SUPABASE_SERVICE_ROLE_KEY is required" }),

  // Session signing secret for the new email-auth session cookie (yt_session)
  // and the legacy express-session cookie. Defaulted in non-production so the
  // backend always starts locally; set a strong value in production.
  APP_SESSION_SECRET: z
    .string()
    .min(16, { message: "APP_SESSION_SECRET must be at least 16 characters" })
    .default("dev-only-insecure-session-secret-change-me"),

  // ── Email (verification + password reset) ──────────────────────────────────
  //
  // Deliberately NOT declared here. The SMTP variables — SMTP_HOST, SMTP_PORT,
  // SMTP_SECURE, SMTP_USER, SMTP_PASSWORD (or SMTP_PASS), SMTP_FROM (or
  // EMAIL_FROM) and DEV_EMAIL_MODE — are read and normalized in config/smtp.ts,
  // which owns the port/secure pairing and strips the spaces out of a Google app
  // password. Declaring them in two places is how a configured SMTP_FROM ended
  // up being ignored, so there is exactly one parser.

  // ── Service-to-service (worker → API realtime events) ──────────────────────
  /**
   * Shared secret the worker presents on /api/internal/reddit/events.
   *
   * MUST be byte-identical in both services. When it is unset the internal
   * endpoint refuses every request — an unauthenticated broadcast channel is
   * worse than no channel, so it fails closed rather than open.
   */
  WORKER_INTERNAL_SECRET: optionalNonEmpty,
  /**
   * WORKER ONLY: where to POST realtime events, e.g.
   * https://yolopulse-api.onrender.com. Unset means the worker persists to the
   * database and publishes nothing — degraded, never broken.
   */
  API_INTERNAL_URL: optionalNonEmpty,
  /** Reserved for a future Pub/Sub transport. Nothing reads it yet. */
  REDIS_URL: optionalNonEmpty,

  // ── Reddit OAuth 2.0 (OPTIONAL / future) ───────────────────────────────────
  // All optional. The client secret is server-side only and never sent to the
  // frontend. See isRedditOAuthConfigured below.
  REDDIT_CLIENT_ID: optionalNonEmpty,
  REDDIT_CLIENT_SECRET: optionalNonEmpty,
  REDDIT_REDIRECT_URI: optionalNonEmpty,
  REDDIT_USER_AGENT: optionalNonEmpty,

  // Reddit username users send their verification code to (inbound only).
  REDDIT_VERIFICATION_USERNAME: z.string().default("yolo-terminal"),

  // ── Google OAuth 2.0 (OPTIONAL) ─────────────────────────────────────────────
  // All optional so the backend always starts. The client secret is server-side
  // only and never sent to the frontend. See isGoogleOAuthConfigured below.
  GOOGLE_CLIENT_ID: optionalNonEmpty,
  GOOGLE_CLIENT_SECRET: optionalNonEmpty,
  GOOGLE_REDIRECT_URI: optionalNonEmpty,

  // Shared secret for the admin-only Reddit-verification review endpoints.
  ADMIN_SECRET: optionalNonEmpty,

  /**
   * Comma-separated emails treated as administrators.
   *
   * The app has no user-role column: identity is email-based and every account
   * is equal. This allowlist is the ONLY thing that makes a signed-in user an
   * admin, and it exists so internal tooling can be reached in production
   * without putting ADMIN_SECRET in a browser.
   *
   * Empty (the default) means NOBODY is an admin — internal pages are then
   * development-only. Compared case-insensitively against the user's email.
   */
  ADMIN_EMAILS: optionalNonEmpty,

  // ── Social data provider (Reddit-like posts/comments/pulse) ────────────────
  // The app never scrapes Reddit. Data comes from a swappable third-party
  // provider queried server-side, or from local demo fixtures.
  //   mock            → centralized local fixtures (default, always available)
  //   mindcase        → third-party aggregator (needs MINDCASE_API_KEY)
  //   brandwatch      → reserved for a future enterprise provider
  //   reddit_official → reserved for the official API once credentials exist
  //   off             → provider disabled; endpoints return an explicit empty
  //                     state instead of data
  SOCIAL_DATA_PROVIDER: z
    .enum(["mock", "mindcase", "brandwatch", "reddit_official", "off"])
    .default("mock"),
  // Server-side only — never sent to the frontend.
  MINDCASE_API_KEY: optionalNonEmpty,
  MINDCASE_BASE_URL: optionalNonEmpty,

  // ── Mindcase rate-limit guards (all optional, safe defaults) ───────────────
  // Mindcase is metered and answers 429 when pushed. These four knobs bound how
  // hard the provider may hit it. Lower MINDCASE_MAX_CONCURRENCY to 1 if 429s
  // persist. See services/social/providers/mindcaseSocialData.provider.ts.
  /** How many subreddits may be fetched at the same time. */
  MINDCASE_MAX_CONCURRENCY: intEnv(2, 1, 16),
  /** Minimum delay between two `/jobs/{id}/results` polls. */
  MINDCASE_POLL_INTERVAL_MS: intEnv(3_000, 250, 60_000),
  /** Max number of result polls before a job is given up on. */
  MINDCASE_MAX_POLLS: intEnv(10, 1, 100),
  /** Retries after a 429 / 5xx before failing with a controlled error. */
  MINDCASE_MAX_RETRIES: intEnv(3, 0, 10),

  // ── Reddit data providers (Mindcase / Arctic Shift) ───────────────────────
  // Only these two knobs live here; the provider selection itself
  // (REDDIT_DATA_MODE, REDDIT_PRIMARY_PROVIDER, the REDDIT_ENABLE_* flags,
  // timeouts and the per-provider settings) is parsed and cross-validated in
  // config/redditDataConfig.ts, which owns that whole surface.
  /**
   * WORKER: whether the Reddit ingestion job is scheduled at all.
   *
   * Defaults to FALSE so deploying this code does not silently start spending
   * provider quota. Set it to true in the environment to turn ingestion on;
   * REDDIT_DATA_MODE then decides which upstream(s) run.
   */
  REDDIT_INGESTION_ENABLED: boolFromString(false),
  /** WORKER: seconds between Reddit ingestion runs. */
  REDDIT_INGESTION_REFRESH_SECONDS: intEnv(900, 60, 86_400),

  /** WORKER: seconds between social ingestion runs (refreshSocialPulse). */
  SOCIAL_DATA_REFRESH_SECONDS: intEnv(600, 60, 86_400),
  /** WORKER: seconds between ticker-strip snapshot runs. */
  TICKER_STRIP_REFRESH_SECONDS: intEnv(300, 60, 86_400),
  /**
   * WORKER: seconds between WSB portfolio/banbet runs. Both jobs derive from
   * data already in the database, so this paces CPU and writes — no provider
   * quota is involved and it can safely be shortened.
   */
  WSB_REFRESH_SECONDS: intEnv(900, 60, 86_400),
  /**
   * WORKER: seconds between Arena ranking runs. Both Arena jobs read stored
   * data only, so this paces CPU and writes — no provider quota is involved.
   */
  ARENA_REFRESH_SECONDS: intEnv(900, 60, 86_400),

  // ── Earnings calendar ──────────────────────────────────────────────────────
  // Which earnings source the WORKER pulls report dates from. `none` is the
  // default and leaves the calendar empty rather than inventing dates for real
  // companies; `mock` is synthetic and refused in production; `fixture` reads
  // the JSON file at EARNINGS_FIXTURE_PATH.
  EARNINGS_DATA_PROVIDER: z.enum(["none", "mock", "fixture"]).default("none"),
  EARNINGS_FIXTURE_PATH: z.string().optional(),
  /**
   * WORKER: seconds between earnings refreshes. Default 6h — earnings dates
   * move on the scale of days, and the provider is metered. The floor is
   * deliberately an hour: there is no legitimate reason to poll faster.
   */
  EARNINGS_REFRESH_SECONDS: intEnv(21_600, 3_600, 604_800),

  // ── Discussion (realtime ticker feed) ──────────────────────────────────────
  /**
   * API: how often the change source looks for new social rows, in ms. This is
   * a DATABASE poll, not a provider one — one pair of queries per tick for the
   * whole server, and only while somebody has the tab open. The 2–5s target
   * latency lives here; the floor stops it being turned into a hot loop.
   */
  DISCUSSION_POLL_MS: intEnv(3_000, 1_000, 60_000),

  // How long a social payload is cached before the provider is queried again.
  // SOCIAL_DATA_CACHE_TTL_SECONDS is the canonical name; SOCIAL_CACHE_TTL_SECONDS
  // is accepted as a legacy alias. Resolved into env.SOCIAL_CACHE_TTL_SECONDS below.
  SOCIAL_DATA_CACHE_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  SOCIAL_CACHE_TTL_SECONDS: z.coerce.number().int().positive().optional(),

  // ── Market data provider (equities + overnight) ────────────────────────────
  // Fully separate from the social/pulse provider above. Provider keys are read
  // only here (backend) and never sent to the frontend.
  //
  // INTENTIONALLY MINIMAL: the ONLY market-data env vars are the six below.
  // Everything else — Databento base URL, equities/overnight/options schemas,
  // the options dataset, symbology types, and the live/real-time/overnight
  // PUBLIC toggles — lives as internal defaults in code (see
  // services/market-data/providers/databento.config.ts). Change those constants,
  // not the environment, to retune Databento.
  //   mock | databento | polygon | alpaca | twelvedata
  MARKET_DATA_PROVIDER: z
    .enum(["mock", "databento", "polygon", "alpaca", "twelvedata"])
    .default("mock"),
  // Display/safety mode. `delayed` is the safe default; `realtime` is never
  // presented publicly in safe mode (see marketData.service) so nothing is ever
  // labeled real-time without an explicit internal-config change.
  MARKET_DATA_MODE: z
    .enum(["mock", "delayed", "realtime", "end_of_day"])
    .default("delayed"),
  MARKET_DATA_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(10),

  /**
   * Master switch for EXTENDED-HOURS support: premarket, after-hours and the
   * overnight session.
   *
   * Defaults to FALSE — the product then works exclusively with the US regular
   * session, 09:30–16:00 America/New_York. With the flag off:
   *   - the worker never requests overnight/extended data from Databento;
   *   - extended-hours changes are not computed;
   *   - premarket / after-hours / overnight snapshots are not persisted;
   *   - reads only serve session="regular" rows, and outside market hours the
   *     last regular-session close is returned, clearly labeled as such.
   *
   * The implementation is NOT deleted — it stays behind this flag. Setting it
   * back to true restores every extended-hours path.
   */
  ENABLE_EXTENDED_HOURS: boolFromString(false),
  /**
   * How far behind real-time the published market data is, in minutes. Shown in
   * the UI ("Delayed 15m") and stored on every worker-written quote/mover row.
   */
  MARKET_DATA_DELAY_MINUTES: intEnv(15, 0, 1_440),
  /**
   * WORKER: seconds between market quote ingestion runs.
   *
   * Default 300, not 60: the delayed path pulls historical bars for the whole
   * watchlist (measured 40-80s per run), and a historical dataset republishes
   * roughly once a day — a 60s loop would fetch continuously for data that has
   * not moved. Lower it only if you move to a feed that updates intraday.
   */
  MARKET_DATA_REFRESH_SECONDS: intEnv(300, 15, 86_400),
  /** WORKER: seconds between market movers snapshot runs. */
  MARKET_MOVERS_REFRESH_SECONDS: intEnv(60, 15, 86_400),

  // Databento — backend-only. The API key plus the two account-specific dataset
  // ids are the ONLY Databento env vars. Blank key = misconfigured → mock
  // fallback (the app never crashes). Schemas/URL/options/flags are code defaults.
  DATABENTO_API_KEY: optionalNonEmpty,
  DATABENTO_DATASET: optionalNonEmpty,
  DATABENTO_OVERNIGHT_DATASET: optionalNonEmpty,

  /**
   * Whether `prisma db seed` may insert DEVELOPMENT/DEMO content — fake users,
   * bets, portfolios, social posts and mock market data.
   *
   * Defaults to FALSE so a seed run against production only writes reference
   * data (the ticker catalog and the default competition definition). It is
   * additionally refused outright when NODE_ENV=production, see
   * `demoSeedAllowed` below — an accidental `SEED_DEMO_DATA=true` in a
   * production environment must not be able to publish fake bets.
   */
  SEED_DEMO_DATA: boolFromString(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Log only the field names / messages — never the values themselves.
  console.error(
    "❌ Invalid environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

const data = parsed.data;

/**
 * Reddit OAuth is only "configured" when a real client id + secret + redirect
 * URI + user agent are all present AND the id/secret are not the shipped
 * placeholders. When false the OAuth routes are disabled but the app still runs.
 */
export const isRedditOAuthConfigured: boolean = Boolean(
  data.REDDIT_CLIENT_ID &&
    data.REDDIT_CLIENT_ID !== REDDIT_ID_PLACEHOLDER &&
    data.REDDIT_CLIENT_SECRET &&
    data.REDDIT_CLIENT_SECRET !== REDDIT_SECRET_PLACEHOLDER &&
    data.REDDIT_REDIRECT_URI &&
    data.REDDIT_USER_AGENT,
);

/**
 * Google OAuth is only "configured" when a real client id + secret are both
 * present AND are not the shipped placeholders. The redirect URI defaults to
 * <BACKEND_URL>/auth/google/callback when not explicitly set. When false the
 * OAuth routes are disabled (503) but the app still runs.
 */
export const isGoogleOAuthConfigured: boolean = Boolean(
  data.GOOGLE_CLIENT_ID &&
    data.GOOGLE_CLIENT_ID !== GOOGLE_ID_PLACEHOLDER &&
    data.GOOGLE_CLIENT_SECRET &&
    data.GOOGLE_CLIENT_SECRET !== GOOGLE_SECRET_PLACEHOLDER,
);

const FRONTEND_ORIGIN =
  data.FRONTEND_ORIGIN ?? data.FRONTEND_URL ?? "http://localhost:5173";

export const env = {
  ...data,
  FRONTEND_ORIGIN,
  // One resolved value under both names, so no consumer has to know which
  // variable the operator happened to set.
  FRONTEND_URL: FRONTEND_ORIGIN,
  // Effective Google redirect URI: explicit value wins, else derive from the
  // backend URL so a minimal id+secret config still works out of the box.
  GOOGLE_REDIRECT_URI:
    data.GOOGLE_REDIRECT_URI ?? `${data.BACKEND_URL}/auth/google/callback`,
  // Canonical cache TTL: prefer the new name, fall back to the legacy alias,
  // default 600s. Code reads env.SOCIAL_CACHE_TTL_SECONDS.
  SOCIAL_CACHE_TTL_SECONDS:
    data.SOCIAL_DATA_CACHE_TTL_SECONDS ?? data.SOCIAL_CACHE_TTL_SECONDS ?? 600,
};

export const isProduction = env.NODE_ENV === "production";

/**
 * Whether premarket / after-hours / overnight are available at all.
 *
 * Read this instead of `env.ENABLE_EXTENDED_HOURS` so every consumer shares one
 * name, and so the flag can later gain extra conditions (a license check, say)
 * in exactly one place.
 */
export const extendedHoursEnabled: boolean = env.ENABLE_EXTENDED_HOURS;

/**
 * Demo/development seed content may only be written when it was explicitly
 * asked for AND this is not production. Two independent conditions on purpose:
 * a stray SEED_DEMO_DATA=true in a production environment must never be able to
 * insert fake users, bets or mock quotes.
 */
export const demoSeedAllowed: boolean = env.SEED_DEMO_DATA && !isProduction;

export type Env = typeof env;
