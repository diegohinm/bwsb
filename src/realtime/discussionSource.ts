import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { discussionHub } from "./discussionHub.js";
import { normalizeComment, normalizePost } from "../services/discussion/discussionRead.service.js";

/**
 * WHERE DISCUSSION EVENTS COME FROM.
 *
 * The API process reads the database; ingestion runs in a separate worker. So
 * this source watches the STORE rather than the provider: every tick it asks
 * for rows touched since its cursor and turns the difference into events.
 *
 * That is a deliberate design choice, not a shortcut:
 *
 *   - it costs ONE pair of queries per tick for the whole server, regardless of
 *     how many people have the tab open — a per-client poll would multiply
 *     load by the audience;
 *   - it works with the connection pooler, which does not support LISTEN;
 *   - it is provider-agnostic by construction. Mindcase, Arctic Shift and the
 *     Reddit API all land in the same tables, so all three already flow through
 *     it, and the frontend cannot tell which produced an event.
 *
 * A future push-based adapter replaces THIS FILE ONLY: it publishes the same
 * events to the same hub, and neither the transports nor the UI change.
 *
 * It only runs while somebody is watching. An unwatched feed costs nothing.
 */

export type DiscussionSourceMode = "database-change-poll";

const DEFAULT_INTERVAL_MS = 3_000;
/** Bound on remembered ids per ticker, so a busy symbol cannot grow forever. */
const SEEN_LIMIT = 600;

type Seen = {
  /** externalId → the score/comment pair last broadcast, to detect updates. */
  posts: Map<string, string>;
  comments: Map<string, string>;
  /** Cursor: the newest `fetched_at` already processed. */
  cursor: Date;
  /** Deletion cursor over `deleted_or_changed_content_events`. */
  deletionCursor: Date;
  primed: boolean;
};

/** The fields whose change makes an item "updated" rather than merely re-seen. */
const postFingerprint = (score: number | null, comments: number | null, stance: string | null) =>
  `${score ?? ""}|${comments ?? ""}|${stance ?? ""}`;
const commentFingerprint = (score: number | null, stance: string | null) =>
  `${score ?? ""}|${stance ?? ""}`;

function remember(map: Map<string, string>, id: string, fingerprint: string): void {
  map.set(id, fingerprint);
  if (map.size > SEEN_LIMIT) {
    // Maps iterate in insertion order, so the first key is the oldest.
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

class DatabaseChangeSource {
  readonly mode: DiscussionSourceMode = "database-change-poll";
  readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly seen = new Map<string, Seen>();

  constructor(intervalMs = DEFAULT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    console.log(
      `[discussion] change source polling every ${this.intervalMs}ms (only while watched)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.seen.clear();
  }

  /** Forget a ticker nobody is watching, so its memory is released. */
  private prune(watched: string[]): void {
    const live = new Set(watched);
    for (const ticker of this.seen.keys()) {
      if (!live.has(ticker)) this.seen.delete(ticker);
    }
  }

  private async tick(): Promise<void> {
    // No overlap: a slow tick must not stack up behind itself.
    if (this.running) return;
    const watched = discussionHub.watchedTickers();
    this.prune(watched);
    if (watched.length === 0) return;

    this.running = true;
    try {
      for (const ticker of watched) {
        await this.pollTicker(ticker);
      }
    } catch (err) {
      // A database blip must not kill the loop — the sockets stay open and the
      // next tick tries again.
      console.error("[discussion] poll failed:", err);
    } finally {
      this.running = false;
    }
  }

  private async pollTicker(ticker: string): Promise<void> {
    let state = this.seen.get(ticker);
    if (!state) {
      state = {
        posts: new Map(),
        comments: new Map(),
        // Look slightly back on the first pass so an item written moments
        // before the subscription is not missed.
        cursor: new Date(Date.now() - 60_000),
        deletionCursor: new Date(),
        primed: false,
      };
      this.seen.set(ticker, state);
    }

    const where = { tickers: { has: ticker }, fetchedAt: { gt: state.cursor } };
    const [posts, comments] = await Promise.all([
      prisma.socialPosts.findMany({
        where,
        orderBy: { fetchedAt: "asc" },
        take: 100,
      }),
      prisma.socialComments.findMany({
        where,
        orderBy: { fetchedAt: "asc" },
        take: 100,
      }),
    ]);

    const at = new Date().toISOString();

    for (const row of posts) {
      const fingerprint = postFingerprint(row.score, row.commentCount, row.stance);
      const known = state.posts.get(row.externalId);
      remember(state.posts, row.externalId, fingerprint);
      if (row.fetchedAt > state.cursor) state.cursor = row.fetchedAt;

      // The priming pass records what already exists WITHOUT emitting: the
      // client just loaded that content over REST, and replaying it as "new"
      // would animate a screenful of items the user is already looking at.
      if (!state.primed) continue;
      if (known === fingerprint) continue;

      discussionHub.publish({
        type: known === undefined ? "newPost" : "updatedPost",
        ticker,
        at,
        post: normalizePost(row, ticker),
      });
    }

    for (const row of comments) {
      const fingerprint = commentFingerprint(row.score, row.stance);
      const known = state.comments.get(row.externalId);
      remember(state.comments, row.externalId, fingerprint);
      if (row.fetchedAt > state.cursor) state.cursor = row.fetchedAt;

      if (!state.primed) continue;
      if (known === fingerprint) continue;

      discussionHub.publish({
        type: known === undefined ? "newComment" : "updatedComment",
        ticker,
        at,
        comment: normalizeComment(row, ticker),
      });
    }

    if (state.primed) await this.pollDeletions(ticker, state, at);
    state.primed = true;
  }

  /**
   * Removals recorded by the moderation/deletion tracker.
   *
   * Nothing writes that table yet, so this currently emits nothing — but the
   * path is real end to end, so the day a producer starts recording removals
   * the feed drops them without a code change. A delete for an id the client
   * never received is harmlessly ignored there.
   */
  private async pollDeletions(ticker: string, state: Seen, at: string): Promise<void> {
    const rows = await prisma.deletedOrChangedContentEvents.findMany({
      where: {
        ticker,
        detectedAt: { gt: state.deletionCursor },
        eventType: { in: ["deleted", "removed"] },
      },
      orderBy: { detectedAt: "asc" },
      take: 50,
    });

    for (const row of rows) {
      if (row.detectedAt > state.deletionCursor) state.deletionCursor = row.detectedAt;
      const id = row.redditCommentId ?? row.redditPostId;
      if (!id) continue;
      discussionHub.publish({
        type: row.contentType === "comment" ? "deletedComment" : "deletedPost",
        ticker,
        at,
        id,
      });
    }
  }
}

export const discussionSource = new DatabaseChangeSource(
  env.DISCUSSION_POLL_MS ?? DEFAULT_INTERVAL_MS,
);
