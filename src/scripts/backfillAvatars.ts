/**
 * backfillAvatars.ts
 *
 * Safe, idempotent migration: give every EXISTING user without an avatar the
 * global default frog avatar. Users who already have a personalized avatar_url
 * are left untouched.
 *
 * The avatar/Google columns are part of the schema (prisma/schema.prisma) and
 * are created by `prisma migrate deploy`, so this script no longer has to add
 * them itself — it only moves data.
 *
 * SERVER-SIDE ONLY. Connects with DATABASE_URL and never logs its value.
 *
 * Usage:
 *   npm run db:backfill-avatars
 */
import "dotenv/config";

import { prisma, disconnectPrisma } from "../lib/prisma.js";
import {
  DEFAULT_AVATAR_URL,
  DEFAULT_AVATAR_TYPE,
  RETIRED_DEFAULT_AVATAR_URLS,
} from "../config/branding.js";

/**
 * "No avatar" = NULL, empty, or whitespace-only. Rows still pointing at a
 * retired default path also count: those were written by an older default, now
 * 404, and are not personalized images. Anything else is a real custom avatar
 * and is never overwritten.
 */
function needsDefaultAvatar(avatarUrl: string | null): boolean {
  if (avatarUrl === null) return true;
  const trimmed = avatarUrl.trim();
  if (trimmed === "") return true;
  return (RETIRED_DEFAULT_AVATAR_URLS as readonly string[]).includes(trimmed);
}

async function main(): Promise<void> {
  try {
    // The whitespace-trimming rule above has no Prisma filter equivalent, so
    // candidates are narrowed to the rows that are not already on the current
    // default and then matched here.
    const candidates = await prisma.appUsers.findMany({
      where: { NOT: { avatarUrl: DEFAULT_AVATAR_URL } },
      select: { id: true, avatarUrl: true },
    });

    const ids = candidates
      .filter((u) => needsDefaultAvatar(u.avatarUrl))
      .map((u) => u.id);

    if (ids.length === 0) {
      console.log("✅ Every user already has an avatar — nothing to backfill.");
      return;
    }

    const { count } = await prisma.appUsers.updateMany({
      where: { id: { in: ids } },
      data: {
        avatarUrl: DEFAULT_AVATAR_URL,
        avatarType: DEFAULT_AVATAR_TYPE,
        updatedAt: new Date(),
      },
    });

    console.log(`✅ Backfilled default avatar for ${count} user(s) without one.`);
  } catch (err) {
    console.error(
      "❌ Avatar backfill failed:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  }
}

void main().finally(disconnectPrisma);
