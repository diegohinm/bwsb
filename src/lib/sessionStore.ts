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

/**
 * Dedicated pool for the session store.
 *
 * This is the ONLY remaining direct use of the pg driver: connect-pg-simple
 * takes a pg Pool and issues its own SQL against the `session` table, so it
 * cannot be given the Prisma client. Every other database access in this
 * project goes through lib/prisma.ts.
 *
 * IT MUST BE CAPPED EXPLICITLY. `connection_limit` in DATABASE_URL is a Prisma
 * parameter — the pg driver ignores it and falls back to its own default of
 * TEN. That made this pool the single largest consumer of a 15-slot pooler:
 * the API process alone could hold 3 Prisma sessions plus 10 here, and adding
 * the worker's 3 put the deployment over the limit before any traffic arrived.
 *
 * Three is ample. A session lookup is one indexed read on the hot path of a
 * request, and requests that need one are already serialized behind the
 * Express handler.
 */
const SESSION_POOL_MAX = 3;

const sessionPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: SESSION_POOL_MAX,
  // Hand idle sessions back to the pooler instead of holding them for the
  // lifetime of the process; a quiet API should not occupy slots at all.
  idleTimeoutMillis: 30_000,
  // Fail fast rather than queueing forever when the pooler is saturated.
  connectionTimeoutMillis: 10_000,
});

// A pool error outside a query (the pooler dropping an idle connection) is
// emitted on the pool itself; without a listener, `pg` turns it into an
// uncaught exception and takes the API down.
sessionPool.on("error", (err) => {
  console.error("[session] idle client error:", err.message);
});

/** Close the session pool during shutdown. Safe to call more than once. */
let sessionPoolClosed = false;

export async function closeSessionPool(): Promise<void> {
  if (sessionPoolClosed) return;
  sessionPoolClosed = true;
  try {
    await sessionPool.end();
  } catch (err) {
    console.error(
      "[session] error closing pool:",
      err instanceof Error ? err.message : err,
    );
  }
}

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
