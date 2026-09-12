import { Prisma } from "@prisma/client";

import { disconnectPrisma, prisma } from "../lib/prisma.js";
import { isMainModule } from "../lib/jobRunner.js";
import { DISPLAY_THRESHOLD } from "../services/extraction/tickerExtraction.service.js";
import { BUCKET_MINUTES, UNKNOWN_SUBREDDIT } from "../services/social/tickerActivity.service.js";

/**
 * BACKFILL `ticker_activity` FROM CONTENT THAT IS ALREADY STORED.
 *
 * The aggregation is written forward, at ingestion. Everything ingested BEFORE
 * it existed has associations but no buckets — so Top Tickers over a 7-day
 * window would show the last few hours and call it a week. This rebuilds the
 * buckets from the associations, which remain the record of what was said.
 *
 * REBUILD, NOT TOP-UP. Each range is deleted and recomputed rather than
 * incremented, which is what makes it safe to run repeatedly, safe to re-run
 * over a range that half-succeeded, and safe to run while ingestion is writing
 * fresh buckets at the other end of the timeline. "Idempotent" here is a
 * property of the algorithm, not a promise about remembering what it did.
 *
 * ONE SQL STATEMENT PER DAY, not a read-modify-write loop in Node: the source
 * rows never leave the database, and the aggregate is computed by exactly the
 * same GROUP BY the raw read path uses — so the backfilled numbers cannot drift
 * from the ones the fallback would produce.
 *
 * USAGE
 *   npm run backfill:reddit -- --from=2026-09-01 --to=2026-09-11
 *   npm run backfill:reddit -- --subreddit=wallstreetbets
 *   npm run backfill:reddit -- --from=2026-09-01 --dry-run
 *
 * NOT AUTOMATIC. Nothing schedules this. It rewrites a range of an analytics
 * table and is meant to be run deliberately, with a range in mind.
 */

type Args = {
  from: Date;
  to: Date;
  subreddit: string | null;
  dryRun: boolean;
};

/** Default look-back when no range is given. */
const DEFAULT_DAYS = 30;

/** One transaction per day of history. Bounds lock duration and WAL growth. */
const CHUNK_MS = 24 * 3_600_000;

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) flags.set(match[1], match[2] ?? "true");
  }

  const to = flags.has("to") ? new Date(flags.get("to")!) : new Date();
  const from = flags.has("from")
    ? new Date(flags.get("from")!)
    : new Date(to.getTime() - DEFAULT_DAYS * CHUNK_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("--from / --to must be parseable dates (e.g. 2026-09-01).");
  }
  if (from >= to) throw new Error(`--from (${from.toISOString()}) must precede --to.`);

  return {
    from,
    to,
    subreddit: flags.get("subreddit")?.trim().toLowerCase() ?? null,
    dryRun: flags.get("dry-run") === "true",
  };
}

/**
 * Scope clause shared by the DELETE and the INSERT.
 *
 * They MUST agree. A delete wider than the insert silently erases buckets the
 * rebuild will not replace; a delete narrower than it leaves the old rows in
 * place to be double-counted alongside the new ones.
 */
function subredditScope(subreddit: string | null, column: string): Prisma.Sql {
  if (!subreddit) return Prisma.sql`TRUE`;
  return Prisma.sql`lower(${Prisma.raw(column)}) = ${subreddit}`;
}

/**
 * Every mention in a range, with the fields a bucket needs.
 *
 * Posts and comments, always both — the association tables are the record of
 * what was said, and which table a mention happens to live in is an
 * implementation detail of Reddit's own structure.
 *
 * `confidence >= DISPLAY_THRESHOLD` is the same filter the read path applies:
 * a mention too weak to show a badge for must not be counted in a ranking
 * either, or the ranking would describe content the reader cannot see.
 */
function mentionSource(args: Args): Prisma.Sql {
  const threshold = new Prisma.Decimal(DISPLAY_THRESHOLD);
  const bucketSeconds = BUCKET_MINUTES * 60;

  return Prisma.sql`
    SELECT l.ticker,
           COALESCE(NULLIF(p.subreddit, ''), ${UNKNOWN_SUBREDDIT}) AS subreddit,
           to_timestamp(floor(extract(epoch FROM p.posted_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket_start,
           'POST'::text AS kind,
           p.stance,
           p.author_hash
      FROM social_post_tickers l
      JOIN social_posts p ON p.id = l.social_post_id
     WHERE l.confidence >= ${threshold}
       AND p.posted_at >= ${args.from} AND p.posted_at < ${args.to}
       AND ${subredditScope(args.subreddit, "p.subreddit")}
    UNION ALL
    SELECT l.ticker,
           COALESCE(NULLIF(c.subreddit, ''), ${UNKNOWN_SUBREDDIT}) AS subreddit,
           to_timestamp(floor(extract(epoch FROM c.posted_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket_start,
           'COMMENT'::text AS kind,
           c.stance,
           c.author_hash
      FROM social_comment_tickers l
      JOIN social_comments c ON c.id = l.social_comment_id
     WHERE l.confidence >= ${threshold}
       AND c.posted_at >= ${args.from} AND c.posted_at < ${args.to}
       AND ${subredditScope(args.subreddit, "c.subreddit")}`;
}

export type BackfillChunkResult = { buckets: number; authors: number };

/**
 * Rebuild one slice.
 *
 * Wrapped in a transaction so no reader can observe the window between the
 * delete and the insert — which would look exactly like a ticker's attention
 * dropping to zero.
 */
async function rebuildChunk(args: Args): Promise<BackfillChunkResult> {
  const source = mentionSource(args);

  return prisma.$transaction(async (tx) => {
    // Scoped by BUCKET, not by posted_at: these are the rows about to be
    // replaced, and a bucket is named by its own start.
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM ticker_activity
       WHERE bucket_minutes = ${BUCKET_MINUTES}
         AND bucket_start >= ${args.from} AND bucket_start < ${args.to}
         AND ${subredditScope(args.subreddit, "subreddit")}`);

    await tx.$executeRaw(Prisma.sql`
      DELETE FROM ticker_activity_authors
       WHERE bucket_minutes = ${BUCKET_MINUTES}
         AND bucket_start >= ${args.from} AND bucket_start < ${args.to}
         AND ${subredditScope(args.subreddit, "subreddit")}`);

    // Membership first, so `unique_authors` below can simply be a COUNT DISTINCT
    // over the same source rather than a second pass over the new table.
    const authors = await tx.$executeRaw(Prisma.sql`
      INSERT INTO ticker_activity_authors
        (ticker, subreddit, bucket_start, bucket_minutes, author_hash)
      SELECT DISTINCT m.ticker, m.subreddit, m.bucket_start, ${BUCKET_MINUTES}, m.author_hash
        FROM (${source}) m
       WHERE m.author_hash IS NOT NULL
      ON CONFLICT DO NOTHING`);

    const buckets = await tx.$executeRaw(Prisma.sql`
      INSERT INTO ticker_activity
        (ticker, subreddit, bucket_start, bucket_minutes,
         mentions, posts, comments, bullish, neutral, bearish, unique_authors)
      SELECT m.ticker,
             m.subreddit,
             m.bucket_start,
             ${BUCKET_MINUTES},
             count(*)::int,
             count(*) FILTER (WHERE m.kind = 'POST')::int,
             count(*) FILTER (WHERE m.kind = 'COMMENT')::int,
             count(*) FILTER (WHERE m.stance = 'bullish')::int,
             -- Anything not explicitly bullish or bearish, NULL included, is
             -- neutral, so the three columns always sum to the mentions count.
             count(*) FILTER (WHERE m.stance IS DISTINCT FROM 'bullish'
                                AND m.stance IS DISTINCT FROM 'bearish')::int,
             count(*) FILTER (WHERE m.stance = 'bearish')::int,
             count(DISTINCT m.author_hash)::int
        FROM (${source}) m
       GROUP BY m.ticker, m.subreddit, m.bucket_start
      ON CONFLICT (ticker, subreddit, bucket_start, bucket_minutes) DO UPDATE SET
        mentions       = EXCLUDED.mentions,
        posts          = EXCLUDED.posts,
        comments       = EXCLUDED.comments,
        bullish        = EXCLUDED.bullish,
        neutral        = EXCLUDED.neutral,
        bearish        = EXCLUDED.bearish,
        unique_authors = EXCLUDED.unique_authors,
        updated_at     = now()`);

    return { buckets, authors };
  });
}

/** How many mentions a range holds, without writing anything. */
async function countMentions(args: Args): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>(
    Prisma.sql`SELECT count(*)::bigint AS n FROM (${mentionSource(args)}) m`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function backfillRedditAnalytics(args: Args): Promise<void> {
  const scope = args.subreddit ? `r/${args.subreddit}` : "every community";
  console.log(
    `[backfill] ${scope} · ${args.from.toISOString()} → ${args.to.toISOString()}` +
      (args.dryRun ? " (DRY RUN — nothing will be written)" : ""),
  );

  if (args.dryRun) {
    const mentions = await countMentions(args);
    console.log(`[backfill] ${mentions} mention(s) would be aggregated. No changes made.`);
    return;
  }

  let buckets = 0;
  let authors = 0;
  let cursor = args.from.getTime();

  while (cursor < args.to.getTime()) {
    const chunkTo = new Date(Math.min(cursor + CHUNK_MS, args.to.getTime()));
    const chunk = { ...args, from: new Date(cursor), to: chunkTo };

    const result = await rebuildChunk(chunk);
    buckets += result.buckets;
    authors += result.authors;

    console.log(
      `[backfill] ${chunk.from.toISOString().slice(0, 10)} → ` +
        `${result.buckets} bucket(s), ${result.authors} author row(s)`,
    );
    cursor = chunkTo.getTime();
  }

  console.log(`[backfill] done — ${buckets} bucket(s), ${authors} author row(s) rebuilt.`);
}

/**
 * Standalone entrypoint, GUARDED BY `isMainModule`.
 *
 * Without the guard, merely importing this file — from a test, an editor's
 * auto-import — would rewrite a month of analytics and then close the shared
 * connection pool underneath whatever else was using it.
 */
if (isMainModule(import.meta.url)) {
  backfillRedditAnalytics(parseArgs(process.argv.slice(2)))
    .catch((err) => {
      console.error("[backfill] failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => void disconnectPrisma());
}
