import "dotenv/config";
import { z } from "zod";

/**
 * Schema for all environment variables the backend depends on.
 * Server-side only — never expose these values to the frontend.
 *
 * Notes on the two "database" URLs:
 *  - DATABASE_URL is a PostgreSQL connection string used by Prisma and by the
 *    session store (connect-pg-simple). This is the app's own database.
 *  - SUPABASE_URL is the Supabase REST endpoint (https://<ref>.supabase.co)
 *    used by the existing tickers feature via @supabase/supabase-js.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Public URLs. FRONTEND_URL is also the only allowed CORS origin.
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  BACKEND_URL: z.string().url().default("http://localhost:4000"),

  // App database (Prisma + session store). Must be a Postgres connection string.
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

  // Session signing secret for express-session cookies.
  SESSION_SECRET: z
    .string()
    .min(16, { message: "SESSION_SECRET must be at least 16 characters" }),

  // Reddit OAuth 2.0 credentials. The client secret is server-side only and is
  // never sent to the frontend.
  //
  // The `.refine` guards reject the placeholder values shipped in .env.example
  // (e.g. "your_reddit_client_id"). Without this, a placeholder passes a plain
  // `.min(1)` check and the app happily builds a Reddit URL with a fake
  // client_id — exactly the "client_id=your_reddit_client_id" bug we're fixing.
  REDDIT_CLIENT_ID: z
    .string()
    .min(1, { message: "REDDIT_CLIENT_ID is required" })
    .refine((v) => !/^your_reddit/i.test(v), {
      message:
        "REDDIT_CLIENT_ID is still the placeholder — set a real client id from https://www.reddit.com/prefs/apps",
    }),
  REDDIT_CLIENT_SECRET: z
    .string()
    .min(1, { message: "REDDIT_CLIENT_SECRET is required" })
    .refine((v) => !/^your_reddit/i.test(v), {
      message:
        "REDDIT_CLIENT_SECRET is still the placeholder — set a real client secret",
    }),
  REDDIT_REDIRECT_URI: z
    .string()
    .url({ message: "REDDIT_REDIRECT_URI must be a valid URL" })
    .refine((v) => /^https?:\/\//i.test(v), {
      message: "REDDIT_REDIRECT_URI must be an http(s) URL",
    }),
  // Descriptive User-Agent required by Reddit (it rate-limits/blocks generic
  // agents). Format: <platform>:<app id>:<version> (by /u/<username>).
  REDDIT_USER_AGENT: z
    .string()
    .min(1, { message: "REDDIT_USER_AGENT is required" }),
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

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

export type Env = typeof env;
