import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { increment } from "../../lib/metrics.js";
import { saveSocialItems } from "../../repositories/socialSnapshots.repository.js";
import type { SocialPostItem } from "../social/socialData.types.js";
import {
  COMMENTS_AGENT,
  POSTS_AGENT,
  formatUsd,
  recordMindcaseUsage,
  type EfficiencyReport,
} from "./mindcaseBudget.service.js";
import {
  isSaturated,
  nextRequestSize,
  nextSyncDelayMs,
  shouldRetire,
  type SyncOutcome,
} from "./redditSyncPlan.js";

/**
 * INCREMENTAL REDDIT SYNC.
 *
 * THE ORDER OF OPERATIONS IS THE POINT:
 *
 *     fetch → identify what is new → persist → update the checkpoint
 *
 * The checkpoint moves LAST and only after a successful write. Advancing it
 * first — or in parallel — means a failed persist silently skips a window that
 * nothing will ever fetch again, and Mindcase has no time filter to go back
 * with. A crash must cost a duplicate request, never a hole in the data.
 *
 * WHAT "INCREMENTAL" CAN MEAN HERE. The agent accepts `{ urls, maxResults }`
 * and nothing else: no `after`, `since`, `cursor`, `page` or `offset`. So this
 * cannot ask for "what changed" — it asks for the newest N from a `/new/`
 * listing and stops at the first id already stored. The checkpoint is what makes
 * the NEXT request smaller, not what filters this one.
 *
 * THE BOUNDARY CHECK DOES NOT SAVE MONEY BY ITSELF, and it is worth being
 * precise about that, because it is the easiest thing to fool yourself about:
 * the rows were already returned and already billed by the time we recognise
 * them. What it buys is the DECISION — it proves we have caught up, which is
 * what lets the next request shrink. The saving is in `maxResults`.
 */

const PROVIDER = "mindcase";

export type StreamKind = "POSTS" | "COMMENTS";

export type SyncCursor = {
  lastCreatedAt: Date | null;
  lastExternalId: string | null;
  consecutiveEmptyRuns: number;
  lastRowsReceived: number;
  lastNewItems: number;
  priority: number;
  isActive: boolean;
};

/** Read a stream's checkpoint, or the cold-start defaults. */
export async function readCursor(
  community: string,
  contentType: StreamKind,
  threadId = "",
): Promise<SyncCursor> {
  const row = await prisma.redditIngestionCursor.findUnique({
    where: {
      provider_subreddit_contentType_threadId: {
        provider: PROVIDER,
        subreddit: community,
        contentType,
        threadId,
      },
    },
  });

  return {
    lastCreatedAt: row?.lastCreatedAt ?? null,
    lastExternalId: row?.lastExternalId ?? null,
    consecutiveEmptyRuns: row?.consecutiveEmptyRuns ?? 0,
    lastRowsReceived: row?.lastRowsReceived ?? 0,
    lastNewItems: row?.lastNewItems ?? 0,
    priority: row?.priority ?? 2,
    isActive: row?.isActive ?? true,
  };
}

/**
 * Advance a checkpoint. CALLED ONLY AFTER A SUCCESSFUL PERSIST.
 *
 * `lastCreatedAt` is the newest timestamp among items we actually STORED, never
 * the newest we saw. If ten items came back and eight were written, the
 * checkpoint belongs at the eighth — claiming the tenth would abandon two items
 * this provider cannot be asked for again.
 */
async function commitCursor(params: {
  community: string;
  contentType: StreamKind;
  threadId?: string;
  newestStoredAt: Date | null;
  newestStoredId: string | null;
  outcome: SyncOutcome;
  baseIntervalMs: number;
  isProtected: boolean;
  priority: number;
}): Promise<void> {
  const empty = params.outcome.newItems === 0;
  const previous = await readCursor(params.community, params.contentType, params.threadId ?? "");
  const consecutiveEmptyRuns = empty ? previous.consecutiveEmptyRuns + 1 : 0;
  const now = new Date();

  const identity = {
    provider: PROVIDER,
    subreddit: params.community,
    contentType: params.contentType,
    threadId: params.threadId ?? "",
  };

  const state = {
    // Never move the checkpoint BACKWARDS. A provider that returns an older
    // batch than last time — reordering, a partial crawl — must not rewind a
    // window that has already been processed.
    ...(params.newestStoredAt &&
    (!previous.lastCreatedAt || params.newestStoredAt > previous.lastCreatedAt)
      ? { lastCreatedAt: params.newestStoredAt, lastExternalId: params.newestStoredId }
      : {}),
    lastAttemptAt: now,
    lastSuccessfulSyncAt: now,
    consecutiveFailures: 0,
    consecutiveEmptyRuns,
    lastRowsReceived: params.outcome.rowsReceived,
    lastNewItems: params.outcome.newItems,
    // A saturated response means there is probably more just past the edge.
    // Recorded so the next size decision can see it without re-deriving it.
    hasMore: isSaturated(params.outcome),
    nextSyncAt: new Date(
      now.getTime() + nextSyncDelayMs(params.baseIntervalMs, consecutiveEmptyRuns),
    ),
    priority: params.priority,
    isActive: !shouldRetire(consecutiveEmptyRuns, params.isProtected),
  };

  await prisma.redditIngestionCursor.upsert({
    where: { provider_subreddit_contentType_threadId: identity },
    create: { ...identity, ...state },
    update: state,
  });
}

/**
 * Record a failed attempt WITHOUT moving the checkpoint.
 *
 * The whole contract: a provider outage or a database error leaves the window
 * exactly where it was, so the next run re-requests it. Nothing is skipped.
 */
async function recordFailure(
  community: string,
  contentType: StreamKind,
  threadId: string,
  message: string,
  baseIntervalMs: number,
): Promise<void> {
  const identity = {
    provider: PROVIDER,
    subreddit: community,
    contentType,
    threadId,
  };
  const state = {
    lastAttemptAt: new Date(),
    lastErrorMessage: message.slice(0, 500),
    consecutiveFailures: { increment: 1 },
    // Backed off, but not retired: a failing stream is not a quiet one.
    nextSyncAt: new Date(Date.now() + baseIntervalMs),
  };

  try {
    await prisma.redditIngestionCursor.upsert({
      where: { provider_subreddit_contentType_threadId: identity },
      create: { ...identity, ...state, consecutiveFailures: 1 },
      update: state,
    });
  } catch (err) {
    console.error("[reddit-sync] could not record failure:", err);
  }
}

/**
 * Which of these items are NOT already stored.
 *
 * One query against the unique external ids rather than one per item. This is
 * also the boundary check: an id we recognise is the edge of what we have.
 */
async function partitionNew(
  items: SocialPostItem[],
  kind: StreamKind,
): Promise<{ fresh: SocialPostItem[]; knownCount: number }> {
  if (items.length === 0) return { fresh: [], knownCount: 0 };

  const ids = items.map((i) => i.id);
  const existing =
    kind === "POSTS"
      ? await prisma.socialPosts.findMany({
          where: { externalId: { in: ids } },
          select: { externalId: true },
        })
      : await prisma.socialComments.findMany({
          where: { externalId: { in: ids } },
          select: { externalId: true },
        });

  const known = new Set(existing.map((r) => r.externalId));
  return {
    fresh: items.filter((i) => !known.has(i.id)),
    knownCount: known.size,
  };
}

function newestOf(items: SocialPostItem[]): { at: Date | null; id: string | null } {
  let at: Date | null = null;
  let id: string | null = null;
  for (const item of items) {
    const t = new Date(item.createdAt);
    if (Number.isNaN(t.getTime())) continue;
    if (!at || t > at) {
      at = t;
      id = item.id;
    }
  }
  return { at, id };
}

export type SyncResult = {
  community: string;
  threadId: string;
  requested: number;
  rowsReceived: number;
  newItems: number;
  duplicates: number;
  storedPosts: number;
  storedComments: number;
  estimatedCostUsd: number;
  boundaryFound: boolean;
  durationMs: number;
  error?: string;
};

/**
 * The shared body of a sync: buy rows, work out what is new, store it, then —
 * and only then — move the checkpoint.
 *
 * Both streams run through here so the checkpoint contract cannot drift between
 * posts and comments. The caller supplies only how to fetch.
 */
async function runSync(params: {
  community: string;
  contentType: StreamKind;
  threadId: string;
  priority: number;
  isProtected: boolean;
  baseIntervalMs: number;
  bounds: { min: number; max: number };
  fetch: (maxResults: number) => Promise<SocialPostItem[]>;
}): Promise<SyncResult> {
  const started = Date.now();
  const cursor = await readCursor(params.community, params.contentType, params.threadId);

  const requested = nextRequestSize(
    cursor.lastRowsReceived > 0
      ? {
          rowsReceived: cursor.lastRowsReceived,
          newItems: cursor.lastNewItems,
          requested: cursor.lastRowsReceived,
        }
      : null,
    params.bounds,
  );

  const base: SyncResult = {
    community: params.community,
    threadId: params.threadId,
    requested,
    rowsReceived: 0,
    newItems: 0,
    duplicates: 0,
    storedPosts: 0,
    storedComments: 0,
    estimatedCostUsd: 0,
    boundaryFound: false,
    durationMs: 0,
  };

  let items: SocialPostItem[];
  try {
    items = await params.fetch(requested);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failed request may still have billed for rows; we cannot know how many,
    // so it is recorded as an error with zero rather than silently omitted.
    await recordMindcaseUsage({
      agent: params.contentType === "POSTS" ? POSTS_AGENT : COMMENTS_AGENT,
      community: params.community,
      threadId: params.threadId,
      rowsReceived: 0,
      newItems: 0,
      outcome: "error",
      error: message,
      durationMs: Date.now() - started,
    });
    await recordFailure(
      params.community,
      params.contentType,
      params.threadId,
      message,
      params.baseIntervalMs,
    );
    return { ...base, durationMs: Date.now() - started, error: message };
  }

  const { fresh, knownCount } = await partitionNew(items, params.contentType);
  const outcome: SyncOutcome = {
    rowsReceived: items.length,
    newItems: fresh.length,
    requested,
  };
  if (knownCount > 0) increment("mindcase_sync_skipped_boundary_total");

  let report: EfficiencyReport;
  let stored = { posts: 0, comments: 0 };

  try {
    // PERSIST BEFORE THE CHECKPOINT MOVES. Only the fresh items are written:
    // re-upserting a row we already have would refresh `fetched_at` for no
    // reason and make "new" unmeasurable on the next pass.
    if (fresh.length > 0) stored = await saveSocialItems(fresh);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report = await recordMindcaseUsage({
      agent: params.contentType === "POSTS" ? POSTS_AGENT : COMMENTS_AGENT,
      community: params.community,
      threadId: params.threadId,
      rowsReceived: outcome.rowsReceived,
      newItems: 0,
      outcome: "error",
      error: message,
      durationMs: Date.now() - started,
    });
    // The rows were bought and the write failed: the checkpoint stays put so the
    // next run re-requests the same window rather than skipping it.
    await recordFailure(
      params.community,
      params.contentType,
      params.threadId,
      message,
      params.baseIntervalMs,
    );
    return {
      ...base,
      rowsReceived: outcome.rowsReceived,
      duplicates: knownCount,
      estimatedCostUsd: report.estimatedCostUsd,
      boundaryFound: knownCount > 0,
      durationMs: Date.now() - started,
      error: message,
    };
  }

  report = await recordMindcaseUsage({
    agent: params.contentType === "POSTS" ? POSTS_AGENT : COMMENTS_AGENT,
    community: params.community,
    threadId: params.threadId,
    rowsReceived: outcome.rowsReceived,
    newItems: outcome.newItems,
    durationMs: Date.now() - started,
  });

  const newest = newestOf(fresh);
  await commitCursor({
    community: params.community,
    contentType: params.contentType,
    threadId: params.threadId,
    newestStoredAt: newest.at,
    newestStoredId: newest.id,
    outcome,
    baseIntervalMs: params.baseIntervalMs,
    isProtected: params.isProtected,
    priority: params.priority,
  });

  return {
    ...base,
    rowsReceived: outcome.rowsReceived,
    newItems: outcome.newItems,
    duplicates: knownCount,
    storedPosts: stored.posts,
    storedComments: stored.comments,
    estimatedCostUsd: report.estimatedCostUsd,
    boundaryFound: knownCount > 0,
    durationMs: Date.now() - started,
  };
}

export { runSync, commitCursor, partitionNew, newestOf, PROVIDER };

/** The mandatory per-sync log line. Credential-free by construction. */
export function logSync(stream: string, marketOpen: boolean, result: SyncResult): void {
  const efficiency =
    result.rowsReceived > 0 ? Math.round((result.newItems / result.rowsReceived) * 100) : 0;

  console.log(
    `[reddit/${stream} sync] community=${result.community}` +
      (result.threadId ? ` thread=${result.threadId}` : "") +
      ` marketOpen=${marketOpen}` +
      ` requested=${result.requested} rowsReceived=${result.rowsReceived}` +
      ` new=${result.newItems} duplicates=${result.duplicates}` +
      ` estimatedCost=${formatUsd(result.estimatedCostUsd)}` +
      ` efficiency=${efficiency}%` +
      ` boundaryFound=${result.boundaryFound}` +
      ` durationMs=${result.durationMs}` +
      (result.error ? ` error="${result.error.slice(0, 120)}"` : ""),
  );
}

/** Interval for the comment stream, from the market's actual state. */
export function commentIntervalMs(marketOpen: boolean): number {
  const minutes = marketOpen
    ? env.REDDIT_COMMENTS_MARKET_OPEN_INTERVAL_MINUTES
    : env.REDDIT_COMMENTS_MARKET_CLOSED_INTERVAL_MINUTES;
  return minutes * 60_000;
}

export function postsIntervalMs(): number {
  return env.REDDIT_POSTS_INTERVAL_MINUTES * 60_000;
}
