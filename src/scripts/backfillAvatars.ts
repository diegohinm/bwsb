/**
 * backfillAvatars.ts
 *
 * Safe, idempotent migration: give every EXISTING user without an avatar the
 * global default frog avatar. Users who already have a personalized avatar_url
 * are left untouched.
 *
 * Also ensures the avatar/Google columns exist so this can be run against an
 * older database without first running the full db:setup.
 *
 * SERVER-SIDE ONLY. Reads DATABASE_URL from the environment. Never logs its value.
 *
 * Usage:
 *   npm run db:backfill-avatars
 */
import "dotenv/config";
import pkg from "pg";
import {
  DEFAULT_AVATAR_URL,
  DEFAULT_AVATAR_TYPE,
  RETIRED_DEFAULT_AVATAR_URLS,
} from "../config/branding.js";

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

async function main(): Promise<void> {
  const client = new Client({ connectionString: getDatabaseUrl() });
  try {
    await client.connect();

    // Make sure the columns exist (safe on already-migrated databases).
    await client.query(
      `ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS avatar_url  text;
       ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS avatar_type text;`,
    );

    // "No avatar" = NULL, empty, or whitespace-only. Rows still pointing at a
    // retired default path are also repointed: those were written by an older
    // default, now 404, and are not personalized images. Anything else is a
    // real custom avatar and is never overwritten.
    const result = await client.query(
      `UPDATE public.app_users
          SET avatar_url  = $1,
              avatar_type = $2,
              updated_at  = now()
        WHERE (avatar_url IS NULL
               OR trim(avatar_url) = ''
               OR trim(avatar_url) = ANY($3::text[]))
          AND coalesce(avatar_url, '') <> $1`,
      [DEFAULT_AVATAR_URL, DEFAULT_AVATAR_TYPE, [...RETIRED_DEFAULT_AVATAR_URLS]],
    );

    console.log(
      `✅ Backfilled default avatar for ${result.rowCount ?? 0} user(s) without one.`,
    );
  } catch (err) {
    console.error(
      "❌ Avatar backfill failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  } finally {
    await client.end();
  }
}

void main();
