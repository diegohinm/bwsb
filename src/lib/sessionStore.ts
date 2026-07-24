import type { RequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pkg from "pg";

import { env, isProduction } from "../config/env.js";

const { Pool } = pkg;

/**
 * PostgreSQL-backed session middleware.
 *
 * Sessions are persisted in the `session` table (auto-created on first run) so
 * they survive restarts and work across multiple backend instances. In-memory
 * sessions are never used — express-session's default MemoryStore is explicitly
 * avoided.
 *
 * The cookie is HttpOnly (never readable by JS), SameSite=Lax, Secure in
 * production, and lasts 30 days. It carries only an opaque session id.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Dedicated pool for the session store. connect-pg-simple manages its own
// connections independently of Prisma.
const sessionPool = new Pool({ connectionString: env.DATABASE_URL });

const PgStore = connectPgSimple(session);

export const sessionMiddleware: RequestHandler = session({
  name: "yp_oauth.sid",
  secret: env.APP_SESSION_SECRET,
  store: new PgStore({
    pool: sessionPool,
    tableName: "session",
    createTableIfMissing: true,
  }),
  resave: false,
  saveUninitialized: false,
  rolling: true, // refresh the 30-day window on each authenticated request
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: THIRTY_DAYS_MS,
  },
});
