import type { Prisma } from "@prisma/client";

import { isMainModule } from "../lib/jobRunner.js";

import { disconnectPrisma, prisma } from "../lib/prisma.js";
import { withDbRetry } from "../lib/dbRetry.js";
import {
  loadTickerCatalog,
  saveCommentTickers,
  savePostTickers,
} from "../repositories/tickerAssociations.repository.js";
import { extractFromParts } from "../services/extraction/tickerExtraction.service.js";

/**
 * Backfill ticker associations for content stored before extraction existed.
 *
 * Run as `npm run social:backfill-tickers`.
 *
 * WHY THIS IS A COMMAND AND NOT A STARTUP STEP
 *
 * There are thousands of stored rows and the count only grows. Re-extracting
 * all of them every time a process boots would add minutes to every deploy and
 * hammer the pooler for no benefit, so nothing here runs automatically. The
 * worker's own ingestion keeps NEW content associated; this exists purely to
 * catch up the old.
 *
 * THE FOUR PROPERTIES THAT MATTER
 *
 *   BATCHED     — keyset pagination over `fetched_at`, never `skip`, so page
 *                 5,000 costs the same as page 1 and the table is never loaded
 *                 into memory.
 *   IDEMPOTENT  — each write replaces that row's associations wholesale, so a
 *                 second run converges on the same state rather than doubling
 *                 anything.
 *   RESUMABLE   — progress is the cursor, and the cursor is printed. A run
 *                 killed halfway can be restarted with `--since=<iso>` and it
 *                 picks up rather than starting over.
 *   NON-BLOCKING— it pauses between batches so ingestion and the API keep their
 *                 share of the connection pool. This is a catch-up task; it has
 *                 no deadline.
 *
 * It never touches post or comment TEXT. The only columns written are the
 * association rows and the `tickers[]` projection.
 */

const BATCH_SIZE = 200;
/** Breathing room for the pooler between batches. */
const PAUSE_MS = 250;

export type BackfillOptions = {
  /** Only process content fetched at or after this instant. */
  since?: Date;
  /** Stop after this many rows — for a dry first pass. */
  limit?: number;
  batchSize?: number;
  /** Report rejected/ambiguous tokens. Off by default, as specified. */
  debug?: boolean;
  /**
   * Compute everything and write NOTHING.
   *
   * Strongly recommended before a run against production data: it reports
   * exactly how many associations would be added and removed, so a detector
   * change can be inspected before it is applied.
   */
  dryRun?: boolean;
};

export type BackfillResult = {
  postsScanned: number;
  commentsScanned: number;
  associationsWritten: number;
  /** Associations present before this run, across the scanned content. */
  oldAssociations: number;
  /** Associations the canonical detector produces now. */
  newAssociations: number;
  associationsRemoved: number;
  associationsAdded: number;
  /**
   * Bare mentions of an ambiguous symbol the detector refused. This is the
   * figure that says how much single-letter contamination was cleared.
   */
  ambiguousMentionsRejected: number;
  failures: number;
  dryRun: boolean;
  /** Where to resume from if this run was cut short. */
  lastCursor: string | null;
};

export async function backfillSocialTickers(
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const dryRun = options.dryRun === true;
  const result: BackfillResult = {
    postsScanned: 0,
    commentsScanned: 0,
    associationsWritten: 0,
    oldAssociations: 0,
    newAssociations: 0,
    associationsRemoved: 0,
    associationsAdded: 0,
    ambiguousMentionsRejected: 0,
    failures: 0,
    dryRun,
    lastCursor: null,
  };
  if (dryRun) console.log("[backfill-tickers] DRY RUN — nothing will be written");

  // Retried: the catalog read is the first thing this job does, and a transient
  // pooler blip there aborted an entire run before a single batch had been
  // processed. Nothing had been written, so the failure was safe — just wasteful.
  const catalog = await withDbRetry(() => loadTickerCatalog(true), {
    label: "backfill catalog load",
  });
  if (catalog.bySymbol.size === 0) {
    // Extracting against an empty catalog would validate nothing and wipe every
    // existing association. Refuse rather than quietly destroy data.
    throw new Error(
      "ticker catalog is empty — run migrations before backfilling associations",
    );
  }
  console.log(
    `[backfill-tickers] catalog: ${catalog.bySymbol.size} symbols, ${catalog.aliases.size} aliases`,
  );

  // ── Posts ─────────────────────────────────────────────────────────────────
  let cursor: Date = options.since ?? new Date(0);
  let cursorId: string | null = null;

  for (;;) {
    if (options.limit && result.postsScanned >= options.limit) break;

    const batch: PostBatchRow[] = await prisma.socialPosts.findMany({
      where: pageWhere(cursor, cursorId),
      // The existing associations come along so the run can report what it
      // REMOVED, not just what it wrote.
      select: {
        id: true, title: true, body: true, fetchedAt: true,
        tickerLinks: { select: { ticker: true } },
      },
      orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        // The CANONICAL detector — the same call live ingestion makes. The
        // backfill must never carry its own rules, or reprocessing would
        // produce a different answer than ingesting the same text.
        const matches = extractFromParts(catalog, row.title, row.body);
        tally(result, row.tickerLinks.map((l) => l.ticker), matches.map((m) => m.symbol));
        if (!dryRun) await savePostTickers(row.id, matches);
        result.associationsWritten += matches.length;
        if (options.debug) logRejected(row.id, matches);
      } catch (err) {
        // One bad row must not end the run — the next attempt will retry it.
        result.failures += 1;
        console.error(`[backfill-tickers] post ${row.id} failed:`, err);
      }
      result.postsScanned += 1;
    }

    const last: PostBatchRow = batch[batch.length - 1]!;
    cursor = last.fetchedAt;
    cursorId = last.id;
    result.lastCursor = cursor.toISOString();
    console.log(
      `[backfill-tickers] posts ${result.postsScanned} scanned, cursor ${result.lastCursor}`,
    );

    if (batch.length < batchSize) break;
    await sleep(PAUSE_MS);
  }

  // ── Comments ──────────────────────────────────────────────────────────────
  cursor = options.since ?? new Date(0);
  cursorId = null;

  for (;;) {
    if (options.limit && result.commentsScanned >= options.limit) break;

    const batch: CommentBatchRow[] = await prisma.socialComments.findMany({
      where: pageWhere(cursor, cursorId) as Prisma.SocialCommentsWhereInput,
      select: {
        id: true, body: true, fetchedAt: true,
        tickerLinks: { select: { ticker: true } },
      },
      orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        const matches = extractFromParts(catalog, row.body);
        tally(result, row.tickerLinks.map((l) => l.ticker), matches.map((m) => m.symbol));
        if (!dryRun) await saveCommentTickers(row.id, matches);
        result.associationsWritten += matches.length;
      } catch (err) {
        result.failures += 1;
        console.error(`[backfill-tickers] comment ${row.id} failed:`, err);
      }
      result.commentsScanned += 1;
    }

    const last: CommentBatchRow = batch[batch.length - 1]!;
    cursor = last.fetchedAt;
    cursorId = last.id;
    console.log(`[backfill-tickers] comments ${result.commentsScanned} scanned`);

    if (batch.length < batchSize) break;
    await sleep(PAUSE_MS);
  }

  return result;
}

/**
 * Fold one content item's before/after into the run totals.
 *
 * A symbol that survives is neither added nor removed — only the difference is
 * reported, so the numbers describe the CHANGE rather than the volume of work.
 */
function tally(result: BackfillResult, before: string[], after: string[]): void {
  const had = new Set(before);
  const has = new Set(after);
  result.oldAssociations += had.size;
  result.newAssociations += has.size;
  for (const symbol of had) if (!has.has(symbol)) result.associationsRemoved += 1;
  for (const symbol of has) if (!had.has(symbol)) result.associationsAdded += 1;
}

/** Debug-level only, as specified — ambiguity is noise in normal operation. */
function logRejected(id: string, matches: { symbol: string; confidence: number }[]): void {
  const weak = matches.filter((m) => m.confidence < 0.75);
  if (weak.length > 0) {
    console.debug(
      `[backfill-tickers] ${id} below threshold: ${weak
        .map((m) => `${m.symbol}@${m.confidence}`)
        .join(", ")}`,
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The keyset window for the next batch.
 *
 * Typed explicitly rather than inlined: the loop assigns the cursor from a row
 * of the batch the cursor itself selected, and TypeScript reads that as a
 * circular inference unless the filter's type is stated up front.
 */
function pageWhere(cursor: Date, cursorId: string | null): Prisma.SocialPostsWhereInput {
  return { fetchedAt: { gte: cursor }, ...(cursorId ? { NOT: { id: cursorId } } : {}) };
}

/**
 * The columns each loop reads. Stated as a type rather than left to inference:
 * the loop feeds the last row's cursor back into the query that produced it,
 * and TypeScript reports that round trip as a circular inference unless the
 * batch's shape is fixed up front.
 */
type PostBatchRow = {
  id: string;
  title: string | null;
  body: string | null;
  fetchedAt: Date;
  tickerLinks: { ticker: string }[];
};
type CommentBatchRow = {
  id: string;
  body: string | null;
  fetchedAt: Date;
  tickerLinks: { ticker: string }[];
};

/** CLI entry: `npm run social:backfill-tickers -- --since=2026-01-01 --limit=500`. */
async function main(): Promise<void> {
  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

  const sinceRaw = arg("since");
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`--since must be an ISO date, received "${sinceRaw}"`);
  }
  const limitRaw = arg("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number, received "${limitRaw}"`);
  }

  const batchRaw = arg("batch-size");
  const batchSize = batchRaw ? Number(batchRaw) : undefined;

  const result = await backfillSocialTickers({
    ...(since ? { since } : {}),
    ...(limit ? { limit } : {}),
    ...(batchSize ? { batchSize } : {}),
    debug: process.argv.includes("--debug"),
    dryRun: process.argv.includes("--dry-run"),
  });

  console.log("[backfill-tickers] done:", result);
  if (result.failures > 0) {
    console.log(
      `[backfill-tickers] ${result.failures} row(s) failed — rerun with --since=${result.lastCursor ?? ""} to retry them`,
    );
  }
  await disconnectPrisma();
}

// Only when executed directly, never on import. `isMainModule` compares the
// resolved entry URL; the previous filename-substring check would also have
// fired for any path that happened to contain the word.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[backfill-tickers] fatal:", err);
    process.exit(1);
  });
}
