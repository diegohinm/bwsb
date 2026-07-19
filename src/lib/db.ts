import pkg, { type QueryResultRow } from "pg";
import { env } from "../config/env.js";

const { Pool } = pkg;

/**
 * Shared PostgreSQL connection pool.
 *
 * Repositories use this for parameterized SQL. SERVER-SIDE ONLY — the pool
 * connects with DATABASE_URL, which is never exposed to the frontend. Cached on
 * globalThis so tsx watch-mode reloads reuse one pool.
 */
const globalForDb = globalThis as unknown as { pgPool: pkg.Pool | undefined };

export const pool = globalForDb.pgPool ?? new Pool({ connectionString: env.DATABASE_URL });

if (env.NODE_ENV !== "production") {
  globalForDb.pgPool = pool;
}

/** Run a parameterized query and return the typed rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

/** Run a query and return the first row, or null when there are none. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
