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

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Public origin of the frontend. Also the only allowed CORS origin. Accepts
  // FRONTEND_ORIGIN (new name); the code still reads env.FRONTEND_URL too (alias
  // added below) for backwards compatibility.
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
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
  EMAIL_FROM: z
    .string()
    .default("YoloPulse <no-reply@yolopulse.com>"),
  SMTP_HOST: optionalNonEmpty,
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: optionalNonEmpty,
  SMTP_PASS: optionalNonEmpty,
  SMTP_SECURE: boolFromString(false),
  // When true (or when SMTP is not configured) emails are printed to the
  // backend console instead of being sent. Must be false in production.
  DEV_EMAIL_MODE: boolFromString(true),

  // ── Reddit OAuth 2.0 (OPTIONAL / future) ───────────────────────────────────
  // All optional. The client secret is server-side only and never sent to the
  // frontend. See isRedditOAuthConfigured below.
  REDDIT_CLIENT_ID: optionalNonEmpty,
  REDDIT_CLIENT_SECRET: optionalNonEmpty,
  REDDIT_REDIRECT_URI: optionalNonEmpty,
  REDDIT_USER_AGENT: optionalNonEmpty,

  // Reddit username users send their verification code to (inbound only).
  REDDIT_VERIFICATION_USERNAME: z.string().default("yolo-terminal"),

  // Shared secret for the admin-only Reddit-verification review endpoints.
  ADMIN_SECRET: optionalNonEmpty,
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

export const env = {
  ...data,
  // Backwards-compatible alias: existing code reads env.FRONTEND_URL.
  FRONTEND_URL: data.FRONTEND_ORIGIN,
};

export const isProduction = env.NODE_ENV === "production";

export type Env = typeof env;
