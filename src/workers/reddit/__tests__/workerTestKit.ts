import "../../../providers/reddit/__tests__/helpers.js";

import { buildRedditConfig, type RedditConfig } from "../../../config/reddit.config.js";
import type { NormalizedRedditPost } from "../../../providers/reddit/types.js";
import type {
  CursorFailureUpdate,
  CursorSuccessUpdate,
  RedditIngestionCursorRow,
  RedditWorkerStateRow,
  RedditWorkerStore,
} from "../redditWorkerStore.js";

/**
 * Test kit for the Arctic Shift worker.
 *
 * The worker's promises are about TIME (five minutes between requests, twelve
 * an hour) and about ORDER (the cursor moves only after the write). Neither can
 * be tested against a real clock or a real database, so both are injected: a
 * `FakeClock` that only advances when a test says so, and an in-memory store
 * that implements the same interface as the Prisma one.
 *
 * Importing the provider test helpers first is what keeps `config/env.ts` from
 * exiting the process, and it forces DATABASE_URL at an unreachable address —
 * so a test that accidentally reaches Prisma fails loudly instead of touching
 * the real database.
 */

/** A clock and a `sleep` that only move when the test moves them. */
export class FakeClock {
  private current: number;

  constructor(startIso = "2026-07-31T10:00:00.000Z") {
    this.current = Date.parse(startIso);
  }

  now = (): number => this.current;

  /** `sleep` that jumps the clock instead of waiting. */
  sleep = async (ms: number): Promise<void> => {
    this.current += Math.max(0, ms);
  };

  advance(ms: number): void {
    this.current += ms;
  }

  get iso(): string {
    return new Date(this.current).toISOString();
  }
}

export interface MemoryStore extends RedditWorkerStore {
  state: RedditWorkerStateRow;
  cursors: Map<string, RedditIngestionCursorRow>;
  leaseHolder: string | null;
}

function cursorKey(provider: string, subreddit: string, contentType: string): string {
  return `${provider}:${subreddit}:${contentType}`;
}

/** An in-memory `RedditWorkerStore` with the same semantics as the SQL one. */
export function memoryStore(
  workerName = "arctic-shift-posts",
  overrides: Partial<RedditWorkerStateRow> = {},
): MemoryStore {
  const store: MemoryStore = {
    state: {
      workerName,
      nextSubredditIndex: 0,
      lastRequestAt: null,
      lastSuccessfulRunAt: null,
      consecutiveFailures: 0,
      blockedUntil: null,
      requestLog: [],
      ...overrides,
    },
    cursors: new Map(),
    leaseHolder: null,

    async loadState() {
      return { ...store.state, requestLog: [...store.state.requestLog] };
    },
    async setNextSubredditIndex(_worker, index) {
      store.state.nextSubredditIndex = index;
    },
    async recordRequestStarted(_worker, at, requestLog) {
      store.state.lastRequestAt = at;
      store.state.requestLog = [...requestLog];
    },
    async setBlockedUntil(_worker, until) {
      store.state.blockedUntil = until;
    },
    async recordCycleOutcome(_worker, outcome) {
      if (outcome.success) {
        store.state.lastSuccessfulRunAt = outcome.at;
        store.state.consecutiveFailures = 0;
      } else {
        store.state.consecutiveFailures += 1;
      }
    },

    async getCursor(provider, subreddit, contentType) {
      return store.cursors.get(cursorKey(provider, subreddit, contentType)) ?? null;
    },
    async recordCursorAttempt() {
      /* attempt timestamps are not asserted on */
    },
    async recordCursorSuccess(
      provider,
      subreddit,
      contentType,
      update: CursorSuccessUpdate,
    ) {
      const key = cursorKey(provider, subreddit, contentType);
      const existing = store.cursors.get(key);
      store.cursors.set(key, {
        provider,
        subreddit,
        contentType,
        // COALESCE: an empty batch keeps the cursor exactly where it was.
        lastCreatedAt: update.lastCreatedAt ?? existing?.lastCreatedAt ?? null,
        lastExternalId: update.lastExternalId ?? existing?.lastExternalId ?? null,
        lastSuccessfulSyncAt: update.syncedAt,
        lastErrorCode: null,
        consecutiveFailures: 0,
        hasMore: update.hasMore,
        cooldownUntil: null,
      });
    },
    async recordCursorFailure(
      provider,
      subreddit,
      contentType,
      update: CursorFailureUpdate,
    ) {
      const key = cursorKey(provider, subreddit, contentType);
      const existing = store.cursors.get(key);
      store.cursors.set(key, {
        provider,
        subreddit,
        contentType,
        // The window is NOT moved by a failure.
        lastCreatedAt: existing?.lastCreatedAt ?? null,
        lastExternalId: existing?.lastExternalId ?? null,
        lastSuccessfulSyncAt: existing?.lastSuccessfulSyncAt ?? null,
        lastErrorCode: update.errorCode,
        consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
        hasMore: existing?.hasMore ?? false,
        cooldownUntil: update.cooldownUntil ?? existing?.cooldownUntil ?? null,
      });
    },

    async acquireLease(_worker, owner) {
      if (store.leaseHolder && store.leaseHolder !== owner) return false;
      store.leaseHolder = owner;
      return true;
    },
    async releaseLease(_worker, owner) {
      if (store.leaseHolder === owner) store.leaseHolder = null;
    },
  };

  return store;
}

/** A config built from explicit values — never from the developer's `.env`. */
export function testRedditConfig(
  overrides: Record<string, string> = {},
): RedditConfig {
  return buildRedditConfig({
    REDDIT_SUBREDDITS: "wallstreetbets,stocks,options,investing,pennystocks",
    REDDIT_POLL_INTERVAL_MS: "300000",
    REDDIT_POST_LIMIT: "100",
    REDDIT_CURSOR_OVERLAP_SECONDS: "120",
    REDDIT_INITIAL_LOOKBACK_MINUTES: "30",
    ...overrides,
  });
}

let postCounter = 0;

/** A normalized post with a distinct id and a controllable creation time. */
export function fakePost(
  overrides: Partial<NormalizedRedditPost> & { externalId?: string } = {},
): NormalizedRedditPost {
  postCounter += 1;
  const externalId = overrides.externalId ?? `post${postCounter}`;
  const createdAt = overrides.createdAt ?? new Date("2026-07-31T09:50:00.000Z");
  return {
    externalId,
    fullname: `t3_${externalId}`,
    subreddit: "wallstreetbets",
    author: "trader",
    title: `Post ${externalId}`,
    body: null,
    permalink: `/r/wallstreetbets/comments/${externalId}/`,
    url: null,
    score: 1,
    upvoteRatio: null,
    commentCount: 0,
    createdAt,
    fetchedAt: new Date("2026-07-31T10:00:00.000Z"),
    primarySource: "arctic_shift",
    sources: ["arctic_shift"],
    ...overrides,
  };
}
