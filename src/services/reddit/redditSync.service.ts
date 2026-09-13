import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { redditConfig } from "../../config/reddit.config.js";
import { increment, setArcticShiftLagSeconds } from "../../lib/metrics.js";
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

/**
 * The DEFAULT cursor namespace, kept as a literal so existing rows keep their
 * identity. Each source owns its own checkpoint row: the unique key already
 * scopes by provider, so a second source needs no schema change and cannot
 * disturb the first one's window.
 */
const PROVIDER = "mindcase";

/** Which upstream a sync is talking to. Decides billing, metrics and cursor. */
export type RedditSource = "arctic_shift" | "mindcase";

export type StreamKind = "POSTS" | "COMMENTS";

/**
 * What a fetch hands back.
 *
 * Richer than a bare array because an incremental source knows two things a
 * list cannot express: how far behind the archive is, and what the newest row
 * on the page was even when every row was already stored. Both are needed to
 * decide what happens next, so both travel with the items.
 */
export type FetchOutcome = {
  items: SocialPostItem[];
  /** Median archive lag for this page, seconds. Null when unmeasurable. */
  lagSeconds: number | null;
  /** Newest timestamp SEEN, duplicates included. Undefined = not applicable. */
  newestSeenAt?: Date | null;
  newestSeenId?: string | null;
  /** The page came back full; more is waiting just past it. */
  hasMore?: boolean;
};

/**
 * The window a fetch should ask for.
 *
 * The metered provider has no server-side time filter and ignores this; Arctic
 * Shift takes it as `after`/`before` and returns only what is genuinely new.
 * It is computed the same way for both so the two paths cannot drift.
 */
export type SyncWindow = {
  /** Exclusive lower bound, already widened by the overlap. Null = cold start. */
  after: Date | null;
  before: Date;
};

export type SyncCursor = {
  lastCreatedAt: Date | null;
  lastExternalId: string | null;
  consecutiveEmptyRuns: number;
  lastRowsReceived: number;
  lastNewItems: number;
  priority: number;
  isActive: boolean;
  /** Consecutive failed attempts against THIS source. Reset to 0 on success. */
  consecutiveFailures: number;
  /** While in the future, this source is benched and the fallback owns the stream. */
  cooldownUntil: Date | null;
};

/**
 * The usage report for a FREE source.
 *
 * A literal zero rather than a call into the metered ledger. Recording a free
 * fetch there would both distort the cost estimate and count toward the budget
 * guard, so the free path never touches it at all.
 */
const FREE_REPORT: EfficiencyReport = {
  rowsReceived: 0,
  newItems: 0,
  duplicateItems: 0,
  estimatedCostUsd: 0,
  newItemRate: 0,
  duplicateRate: 0,
  costPerNewItem: null,
};

/**
 * WHERE A COLD START BEGINS.
 *
 * Never "the beginning". An ascending query with no lower bound asks the
 * archive for the oldest content it holds, so a missing checkpoint must resolve
 * to a recent instant or the first tick starts ingesting the community from its
 * founding year.
 *
 * The preferred answer is the newest row already stored for this stream: it
 * makes a restart gap-free without needing the checkpoint to have survived, and
 * it is the same value regardless of which source wrote that row — which is
 * what lets the two sources hand off to each other.
 *
 * That is only trusted while it is RECENT, though. A high-water mark from weeks
 * ago is not a resume point, it is a backfill request, and a routine tick must
 * not start one on its own. Beyond the floor the window falls back to the
 * configured look-back, which is a small, bounded amount of recent history.
 */
async function coldStartWindow(
  community: string,
  contentType: StreamKind,
  now: Date,
): Promise<Date> {
  const lookback = new Date(
    now.getTime() - redditConfig.initialLookbackMinutes * 60_000,
  );
  const floor = new Date(now.getTime() - env.ARCTIC_SHIFT_MAX_CATCHUP_HOURS * 3_600_000);

  try {
    const newest =
      contentType === "POSTS"
        ? await prisma.socialPosts.findFirst({
            where: { subreddit: community },
            orderBy: { postedAt: "desc" },
            select: { postedAt: true },
          })
        : await prisma.socialComments.findFirst({
            where: { subreddit: community },
            orderBy: { postedAt: "desc" },
            select: { postedAt: true },
          });

    const stored = newest?.postedAt ?? null;
    if (stored && stored.getTime() > floor.getTime()) return stored;
  } catch (err) {
    // A database that cannot answer must not widen the window. The look-back is
    // the safe reading of "we do not know where we were".
    console.warn(
      "[reddit-sync] could not read the stored high-water mark; using the look-back:",
      err instanceof Error ? err.message : err,
    );
  }

  return lookback;
}

/** Read a stream's checkpoint, or the cold-start defaults. */
export async function readCursor(
  community: string,
  contentType: StreamKind,
  threadId = "",
  provider: string = PROVIDER,
): Promise<SyncCursor> {
  const row = await prisma.redditIngestionCursor.findUnique({
    where: {
      provider_subreddit_contentType_threadId: {
        provider,
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
    // The fallback state machine's durable memory. On the cursor row rather
    // than in a module-level Map so a crash-looping worker cannot forget that
    // the primary is unhealthy and re-authorize metered spend on every boot.
    consecutiveFailures: row?.consecutiveFailures ?? 0,
    cooldownUntil: row?.cooldownUntil ?? null,
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
  /**
   * Newest item SEEN on this page, stored or already-known.
   *
   * THE ANTI-PIN. With a server-side `after` filter, advancing only to the
   * newest item actually STORED deadlocks a stream the moment a full page comes
   * back entirely duplicate: nothing was stored, the checkpoint does not move,
   * and the identical page is requested forever while genuinely new content
   * sits just past its edge. Advancing to the newest SEEN row cannot skip
   * anything - a seen row is by definition one we already hold - and it is what
   * lets the window walk forward through a wall of duplicates.
   *
   * The metered provider leaves this undefined: with no `after` to send, its
   * pages are not a walk and the stored-only rule remains the safe one there.
   */
  newestSeenAt?: Date | null;
  newestSeenId?: string | null;
  outcome: SyncOutcome;
  baseIntervalMs: number;
  isProtected: boolean;
  priority: number;
  provider?: string;
}): Promise<void> {
  const provider = params.provider ?? PROVIDER;
  const empty = params.outcome.newItems === 0;
  const previous = await readCursor(
    params.community,
    params.contentType,
    params.threadId ?? "",
    provider,
  );
  const consecutiveEmptyRuns = empty ? previous.consecutiveEmptyRuns + 1 : 0;
  const now = new Date();

  const identity = {
    provider,
    subreddit: params.community,
    contentType: params.contentType,
    threadId: params.threadId ?? "",
  };

  // Prefer the newest SEEN row when the caller supplied one (see the field docs
  // above); fall back to the newest STORED row otherwise.
  const advanceTo = params.newestSeenAt ?? params.newestStoredAt;
  const advanceId = params.newestSeenAt ? (params.newestSeenId ?? null) : params.newestStoredId;

  const state = {
    // Never move the checkpoint BACKWARDS. A provider that returns an older
    // batch than last time — reordering, a partial crawl — must not rewind a
    // window that has already been processed.
    ...(advanceTo && (!previous.lastCreatedAt || advanceTo > previous.lastCreatedAt)
      ? { lastCreatedAt: advanceTo, lastExternalId: advanceId }
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
    // A successful cycle ends any bench sentence for this source. Clearing it
    // HERE - after a durable write - is what makes recovery automatic: the next
    // `resolveSourceFor` reads a healthy row and stops using the fallback.
    cooldownUntil: null,
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
  options: {
    provider?: string;
    /** Consecutive failures that bench this source. 0 disables benching. */
    failureThreshold?: number;
    /** How long a benched source stays benched before it is probed again. */
    cooldownMs?: number;
  } = {},
): Promise<void> {
  const provider = options.provider ?? PROVIDER;
  const identity = {
    provider,
    subreddit: community,
    contentType,
    threadId,
  };

  // Read-then-write rather than a bare increment, because the DECISION to bench
  // depends on the resulting count. A blind `{ increment: 1 }` cannot tell
  // whether it has just crossed the threshold.
  const previous = await readCursor(community, contentType, threadId, provider).catch(
    () => null,
  );
  const failures = (previous?.consecutiveFailures ?? 0) + 1;
  const threshold = options.failureThreshold ?? 0;
  const benched =
    threshold > 0 && failures >= threshold && options.cooldownMs !== undefined;

  const state = {
    lastAttemptAt: new Date(),
    lastErrorMessage: message.slice(0, 500),
    consecutiveFailures: failures,
    // Backed off, but not retired: a failing stream is not a quiet one.
    nextSyncAt: new Date(Date.now() + baseIntervalMs),
    // ONE isolated failure must not move spend to a metered provider. The bench
    // is applied only once the count reaches the configured threshold, and it
    // expires on its own so recovery needs no operator action.
    ...(benched
      ? { cooldownUntil: new Date(Date.now() + (options.cooldownMs ?? 0)) }
      : {}),
  };

  try {
    await prisma.redditIngestionCursor.upsert({
      where: { provider_subreddit_contentType_threadId: identity },
      create: { ...identity, ...state },
      update: state,
    });
  } catch (err) {
    console.error("[reddit-sync] could not record failure:", err);
  }
}

/**
 * Bench a source that is WORKING but too far behind to be useful.
 *
 * Separate from `recordFailure` on purpose: excessive archive lag is not an
 * error, and counting it as one would conflate "the upstream is broken" with
 * "the upstream is healthy and merely slow". They need different logs, and the
 * failure counter must stay a count of actual failures.
 */
export async function benchSource(params: {
  community: string;
  contentType: StreamKind;
  threadId?: string;
  provider: string;
  cooldownMs: number;
  reason: string;
}): Promise<void> {
  const identity = {
    provider: params.provider,
    subreddit: params.community,
    contentType: params.contentType,
    threadId: params.threadId ?? "",
  };
  const state = {
    lastAttemptAt: new Date(),
    lastErrorMessage: params.reason.slice(0, 500),
    cooldownUntil: new Date(Date.now() + params.cooldownMs),
  };
  try {
    await prisma.redditIngestionCursor.upsert({
      where: { provider_subreddit_contentType_threadId: identity },
      create: { ...identity, ...state },
      update: state,
    });
  } catch (err) {
    console.error("[reddit-sync] could not bench source:", err);
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
  // THE CROSS-SOURCE IDENTITY. `external_id` is not comparable between sources:
  // the metered provider rarely returns a usable Reddit id and falls back to a
  // content hash, so the stored corpus is keyed on values the archive will never
  // produce. Matching on `external_id` alone would therefore classify every
  // historical row as unseen and re-ingest the entire corpus under new ids.
  //
  // That is not a self-correcting mistake. Ticker activity counts only
  // first-time associations and only ever increments, so a duplicated corpus
  // permanently inflates every ranking derived from it.
  //
  // `reddit_id` — the `t3_`/`t1_` fullname — IS common to both: the metered rows
  // carry it correctly even when their `external_id` is a hash. So identity is
  // "either key matches", which makes the two sources interchangeable without
  // migrating a single row.
  const fullnames = items
    .map((i) => i.redditId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  const existing =
    kind === "POSTS"
      ? await prisma.socialPosts.findMany({
          where: {
            OR: [
              { externalId: { in: ids } },
              ...(fullnames.length > 0 ? [{ redditId: { in: fullnames } }] : []),
            ],
          },
          select: { externalId: true, redditId: true },
        })
      : await prisma.socialComments.findMany({
          where: {
            OR: [
              { externalId: { in: ids } },
              ...(fullnames.length > 0 ? [{ redditId: { in: fullnames } }] : []),
            ],
          },
          select: { externalId: true, redditId: true },
        });

  const knownExternalIds = new Set(existing.map((r) => r.externalId));
  const knownFullnames = new Set(
    existing.map((r) => r.redditId).filter((v): v is string => typeof v === "string"),
  );

  const fresh = items.filter(
    (i) => !knownExternalIds.has(i.id) && !(i.redditId && knownFullnames.has(i.redditId)),
  );

  return { fresh, knownCount: items.length - fresh.length };
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
  /** Which upstream actually answered. Exactly one per cycle, always. */
  source: RedditSource;
  /** Archive lag observed this cycle. Null when the source cannot report it. */
  lagSeconds: number | null;
  /** The page came back full; a catch-up pass may be warranted. */
  hasMore: boolean;
  /**
   * Newest timestamp this page SAW, duplicates included.
   *
   * The catch-up loop pages from this rather than from the checkpoint — see
   * `afterOverride`. Null when the source reports no position.
   */
  newestSeenAt: Date | null;
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
  /**
   * Buy/collect rows. Receives the window as well as the size, because a source
   * with a server-side time filter can use it and one without it can ignore it.
   */
  fetch: (maxResults: number, window: SyncWindow) => Promise<FetchOutcome>;
  /** Which upstream is being used this cycle. Decides billing and the cursor. */
  source?: RedditSource;
  /** Overlap, in seconds, subtracted from the checkpoint to build `after`. */
  overlapSeconds?: number;
  /**
   * Start this pass HERE instead of at the stored checkpoint, with no overlap.
   *
   * Used only by the catch-up loop, to page forward WITHIN one tick. The
   * checkpoint cannot serve that purpose: it is durable state that must never
   * rewind, so it deliberately refuses to move for a page that lies entirely
   * behind it — which is exactly what a page consumed by the overlap looks
   * like. Deriving every page's window from the checkpoint therefore makes the
   * second page identical to the first. Pagination position and durable
   * position are different things and this is the former.
   */
  afterOverride?: Date;
  /** Consecutive failures that bench this source. Omit to never bench. */
  failureThreshold?: number;
  cooldownMs?: number;
}): Promise<SyncResult> {
  const started = Date.now();
  const source: RedditSource = params.source ?? "mindcase";
  // Each source keeps its own checkpoint row, so switching between them cannot
  // corrupt the other's window.
  const cursorProvider = source;
  const metered = source === "mindcase";
  const cursor = await readCursor(
    params.community,
    params.contentType,
    params.threadId,
    cursorProvider,
  );

  // THE WINDOW. `after` is EXCLUSIVE upstream, and archives hand out several
  // items sharing one second, so asking for `> checkpoint` silently drops every
  // sibling of the checkpoint item. Widening by the overlap and de-duplicating
  // by id afterwards is what makes the boundary lossless.
  const overlapMs = (params.overlapSeconds ?? 0) * 1_000;
  const now = new Date();
  const floor = new Date(now.getTime() - env.ARCTIC_SHIFT_MAX_CATCHUP_HOURS * 3_600_000);

  // A checkpoint is usable only while it is recent. One from far enough back is
  // indistinguishable from none at all for scheduling purposes, and following it
  // would turn a routine tick into an unbounded historical backfill.
  const usableCheckpoint =
    cursor.lastCreatedAt && cursor.lastCreatedAt.getTime() > floor.getTime()
      ? cursor.lastCreatedAt
      : null;

  // An explicit pagination position wins, and takes NO overlap: the overlap
  // exists to re-examine the boundary around a durable checkpoint, and
  // re-applying it to each page of a walk would drag every page back over
  // ground the previous one just covered.
  let window: SyncWindow;
  if (params.afterOverride) {
    window = { after: params.afterOverride, before: now };
  } else {
    const anchor =
      usableCheckpoint ?? (await coldStartWindow(params.community, params.contentType, now));
    window = { after: new Date(anchor.getTime() - overlapMs), before: now };
  }

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
    source,
    lagSeconds: null,
    hasMore: false,
    newestSeenAt: null,
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

  let fetched: FetchOutcome;
  try {
    fetched = await params.fetch(requested, window);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (metered) {
      // A failed metered request may still have billed for rows; we cannot know
      // how many, so it is recorded as an error with zero rather than omitted.
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
    } else {
      increment("arctic_shift_errors_total");
    }
    await recordFailure(
      params.community,
      params.contentType,
      params.threadId,
      message,
      params.baseIntervalMs,
      {
        provider: cursorProvider,
        ...(params.failureThreshold !== undefined
          ? { failureThreshold: params.failureThreshold }
          : {}),
        ...(params.cooldownMs !== undefined ? { cooldownMs: params.cooldownMs } : {}),
      },
    );
    return { ...base, source, durationMs: Date.now() - started, error: message };
  }

  const items = fetched.items;

  const { fresh, knownCount } = await partitionNew(items, params.contentType);
  const outcome: SyncOutcome = {
    rowsReceived: items.length,
    newItems: fresh.length,
    requested,
  };
  if (knownCount > 0) {
    increment(
      metered ? "mindcase_sync_skipped_boundary_total" : "arctic_shift_duplicate_items_total",
      metered ? 1 : knownCount,
    );
  }
  if (!metered) {
    increment("arctic_shift_requests_total");
    increment(
      params.contentType === "POSTS"
        ? "arctic_shift_posts_received_total"
        : "arctic_shift_comments_received_total",
      outcome.rowsReceived,
    );
    increment("arctic_shift_new_items_total", outcome.newItems);
    if (fetched.lagSeconds !== null) setArcticShiftLagSeconds(fetched.lagSeconds);
  }

  let report: EfficiencyReport;
  let stored = { posts: 0, comments: 0 };

  try {
    // PERSIST BEFORE THE CHECKPOINT MOVES. Only the fresh items are written:
    // re-upserting a row we already have would refresh `fetched_at` for no
    // reason and make "new" unmeasurable on the next pass.
    if (fresh.length > 0) stored = await saveSocialItems(fresh);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report = metered
      ? await recordMindcaseUsage({
          agent: params.contentType === "POSTS" ? POSTS_AGENT : COMMENTS_AGENT,
          community: params.community,
          threadId: params.threadId,
          rowsReceived: outcome.rowsReceived,
          newItems: 0,
          outcome: "error",
          error: message,
          durationMs: Date.now() - started,
        })
      : FREE_REPORT;
    // The rows were collected and the write failed: the checkpoint stays put so
    // the next run re-requests the same window rather than skipping it.
    await recordFailure(
      params.community,
      params.contentType,
      params.threadId,
      message,
      params.baseIntervalMs,
      {
        provider: cursorProvider,
        ...(params.failureThreshold !== undefined
          ? { failureThreshold: params.failureThreshold }
          : {}),
        ...(params.cooldownMs !== undefined ? { cooldownMs: params.cooldownMs } : {}),
      },
    );
    return {
      ...base,
      source,
      rowsReceived: outcome.rowsReceived,
      duplicates: knownCount,
      estimatedCostUsd: report.estimatedCostUsd,
      boundaryFound: knownCount > 0,
      durationMs: Date.now() - started,
      error: message,
    };
  }

  // BILLING IS SOURCE-CONDITIONAL, and this is load-bearing rather than tidy:
  // booking free Arctic Shift rows through the metered ledger would price them
  // at the per-row rate, inflate the estimated spend, and eventually trip the
  // daily budget guard — pausing ingestion because a FREE provider was working
  // too well. The counter that must stay at zero has to actually stay at zero.
  report = metered
    ? await recordMindcaseUsage({
        agent: params.contentType === "POSTS" ? POSTS_AGENT : COMMENTS_AGENT,
        community: params.community,
        threadId: params.threadId,
        rowsReceived: outcome.rowsReceived,
        newItems: outcome.newItems,
        durationMs: Date.now() - started,
      })
    : FREE_REPORT;

  const newest = newestOf(fresh);
  await commitCursor({
    community: params.community,
    contentType: params.contentType,
    threadId: params.threadId,
    newestStoredAt: newest.at,
    newestStoredId: newest.id,
    // Supplied only by a source with a server-side `after`. See the anti-pin
    // note on commitCursor: without it an all-duplicate page stalls the stream.
    ...(fetched.newestSeenAt !== undefined
      ? { newestSeenAt: fetched.newestSeenAt, newestSeenId: fetched.newestSeenId ?? null }
      : {}),
    provider: cursorProvider,
    outcome,
    baseIntervalMs: params.baseIntervalMs,
    isProtected: params.isProtected,
    priority: params.priority,
  });

  return {
    ...base,
    lagSeconds: fetched.lagSeconds,
    hasMore: fetched.hasMore ?? false,
    newestSeenAt: fetched.newestSeenAt ?? null,
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

/**
 * Where the NEXT page of a catch-up walk should start, or null to stop.
 *
 * Pure, and separated out because the interesting case is the one that looks
 * like the boring case. A full page whose rows are all already stored is not a
 * quiet stream — it is the overlap window being wider than a page — and the
 * difference between continuing and stopping there is the difference between a
 * stream that keeps up and one that wedges permanently while reporting itself
 * healthy.
 *
 * The rules, in order:
 *   - a SHORT page means the window is exhausted: stop, we are current.
 *   - no reported position means the source cannot be paged at all: stop.
 *   - a position that does not move strictly forward: stop, or the walk spins.
 *   - otherwise continue from where this page actually ended, regardless of how
 *     many of its rows were new.
 */
export function nextCatchUpPosition(page: {
  hasMore: boolean;
  newItems: number;
  newestSeenAt: Date | null;
  position: Date | undefined;
}): Date | null {
  if (!page.hasMore) return null;
  if (!page.newestSeenAt) return null;
  if (page.position && page.newestSeenAt.getTime() <= page.position.getTime()) return null;
  return page.newestSeenAt;
}

/**
 * Run a stream forward until it is current, or until the page budget runs out.
 *
 * WHY A LOOP OF WHOLE SYNCS rather than a loop of fetches inside one sync. Each
 * pass is a complete fetch -> persist -> checkpoint cycle, so the contract that
 * the checkpoint never moves ahead of durable data holds for EVERY page, not
 * just the last one. A worker killed halfway through a catch-up keeps every
 * page it already stored and resumes from exactly there; a single sync that
 * paged internally and committed once at the end would lose the whole run.
 *
 * WHY IT IS BOUNDED. A worker that was off for hours has a backlog wider than
 * one page, and `hasMore` will keep being true until it is cleared. Without a
 * cap this becomes an unbounded loop that holds the tick open indefinitely and
 * hammers a free community service to do it. With the cap, a long outage is
 * worked off progressively across consecutive ticks — slower to converge, but
 * it always terminates and the next tick always gets a turn.
 *
 * A pass that stores nothing new ends the loop too: if a full page was entirely
 * duplicates the checkpoint has still advanced past it (see the anti-pin note
 * on commitCursor), so continuing would only re-walk ground already covered.
 */
async function runSyncUntilCurrent(
  params: Parameters<typeof runSync>[0] & { maxPages?: number },
): Promise<SyncResult[]> {
  const maxPages = Math.max(1, params.maxPages ?? 1);
  const results: SyncResult[] = [];
  let cursorPosition: Date | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await runSync({
      ...params,
      // The first pass starts from the durable checkpoint (minus the overlap);
      // every later pass starts where the previous page actually ended.
      ...(cursorPosition ? { afterOverride: cursorPosition } : {}),
    });
    results.push(result);

    if (result.error) break;

    const next = nextCatchUpPosition({
      hasMore: result.hasMore,
      newItems: result.newItems,
      newestSeenAt: result.newestSeenAt,
      position: cursorPosition,
    });
    if (!next) break;
    cursorPosition = next;
  }

  return results;
}

export {
  runSync,
  runSyncUntilCurrent,
  commitCursor,
  partitionNew,
  newestOf,
  PROVIDER,
};

/** The mandatory per-sync log line. Credential-free by construction. */
export function logSync(stream: string, marketOpen: boolean, result: SyncResult): void {
  const efficiency =
    result.rowsReceived > 0 ? Math.round((result.newItems / result.rowsReceived) * 100) : 0;

  console.log(
    `[reddit/${stream} sync] source=${result.source}` +
      ` community=${result.community}` +
      (result.threadId ? ` thread=${result.threadId}` : "") +
      (result.lagSeconds !== null ? ` lagSeconds=${result.lagSeconds}` : "") +
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
