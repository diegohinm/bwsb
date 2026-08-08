import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { discussionHub } from "./discussionHub.js";
import { normalizeComment, normalizePost } from "../services/discussion/discussionRead.service.js";
import {
  badgesForComments,
  badgesForPosts,
} from "../repositories/tickerAssociations.repository.js";
import { DISPLAY_THRESHOLD } from "../services/extraction/tickerExtraction.service.js";

/**
 * WHERE DISCUSSION EVENTS COME FROM.
 *
 * The API process reads the database; ingestion runs in a separate worker. So
 * this source watches the STORE rather than the provider: every tick it asks
 * for rows touched since its cursor and turns the difference into events.
 *
 * ONE PAIR OF QUERIES PER TICK, for the whole server, no matter how many
 * tickers are being watched or how many people are watching them. It polls
 * recently-changed rows without a ticker filter and fans each one out to the
 * rooms that care — the per-ticker rooms named in its `tickers` array, and the
 * global room the /discussion page uses. The earlier design ran one query pair
 * PER WATCHED TICKER, which multiplied database load by the audience for no
 * additional information.
 *
 * It is provider-agnostic by construction: Mindcase, Arctic Shift and the
 * Reddit API all land in the same tables, so all three already flow through it
 * and the frontend cannot tell which produced an event.
 *
 * A future push-based adapter replaces THIS FILE ONLY: it publishes the same
 * events to the same hub, and neither the transports nor the UI change.
 *
 * It only runs while somebody is watching. An unwatched feed costs nothing.
 */

export type DiscussionSourceMode = "database-change-poll";

const DEFAULT_INTERVAL_MS = 3_000;
/** Bound on remembered ids, so a busy period cannot grow the map forever. */
const SEEN_LIMIT = 2_000;
/** Rows examined per tick. A burst larger than this is caught on the next one. */
const BATCH = 200;

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

  /** externalId → last fingerprint broadcast, so an update is distinguishable. */
  private readonly seenPosts = new Map<string, string>();
  private readonly seenComments = new Map<string, string>();
  /** Cursor: the newest `fetched_at` already processed. */
  private cursor = new Date(Date.now() - 60_000);
  private deletionCursor = new Date();
  private primed = false;

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
    this.seenPosts.clear();
    this.seenComments.clear();
    this.primed = false;
  }

  private async tick(): Promise<void> {
    // No overlap: a slow tick must not stack up behind itself.
    if (this.running) return;
    // Nobody watching a ticker AND nobody watching globally → no work.
    if (discussionHub.watchedTickers().length === 0) return;

    this.running = true;
    try {
      await this.poll();
    } catch (err) {
      // A database blip must not kill the loop — the sockets stay open and the
      // next tick tries again.
      console.error("[discussion] poll failed:", err);
    } finally {
      this.running = false;
    }
  }

  /**
   * Publish one item to every room it belongs to.
   *
   * A post about both NVDA and AMD reaches both rooms; the hub adds the global
   * room itself. An item with no ticker still reaches the global feed, under a
   * scope marker that no per-ticker room can match.
   */
  private fanOut(
    tickers: string[],
    at: string,
    build: (ticker: string) => Parameters<typeof discussionHub.publish>[0],
  ): void {
    const symbols = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) {
      // Untagged content is still discussion; it just belongs to no ticker.
      discussionHub.publish(build(""));
      return;
    }
    for (const symbol of symbols) discussionHub.publish(build(symbol));
  }

  private async poll(): Promise<void> {
    const where = { fetchedAt: { gt: this.cursor } };
    const [posts, comments] = await Promise.all([
      prisma.socialPosts.findMany({ where, orderBy: { fetchedAt: "asc" }, take: BATCH }),
      prisma.socialComments.findMany({ where, orderBy: { fetchedAt: "asc" }, take: BATCH }),
    ]);

    // A live row must arrive with the same badges the REST snapshot would have
    // given it — otherwise an item gains its tickers only after a refresh, and
    // the feed contradicts itself while the reader is watching. Two queries per
    // poll, regardless of how many rows changed.
    const [postBadges, commentBadges] = await Promise.all([
      badgesForPosts(posts.map((p) => p.id), DISPLAY_THRESHOLD),
      badgesForComments(comments.map((c) => c.id), DISPLAY_THRESHOLD),
    ]);

    const at = new Date().toISOString();
    let newest = this.cursor;

    for (const row of posts) {
      const fingerprint = postFingerprint(row.score, row.commentCount, row.stance);
      const known = this.seenPosts.get(row.externalId);
      remember(this.seenPosts, row.externalId, fingerprint);
      if (row.fetchedAt > newest) newest = row.fetchedAt;

      // The priming pass records what already exists WITHOUT emitting: the
      // client just loaded that content over REST, and replaying it as "new"
      // would animate a screenful of items the user is already looking at.
      if (!this.primed || known === fingerprint) continue;

      const type = known === undefined ? "newPost" : "updatedPost";
      this.fanOut(row.tickers ?? [], at, (ticker) => ({
        type,
        ticker,
        at,
        post: normalizePost(row, ticker, postBadges.get(row.id) ?? []),
      }));
    }

    for (const row of comments) {
      const fingerprint = commentFingerprint(row.score, row.stance);
      const known = this.seenComments.get(row.externalId);
      remember(this.seenComments, row.externalId, fingerprint);
      if (row.fetchedAt > newest) newest = row.fetchedAt;

      if (!this.primed || known === fingerprint) continue;

      const type = known === undefined ? "newComment" : "updatedComment";
      this.fanOut(row.tickers ?? [], at, (ticker) => ({
        type,
        ticker,
        at,
        comment: normalizeComment(row, ticker, commentBadges.get(row.id) ?? []),
      }));
    }

    this.cursor = newest;
    if (this.primed) await this.pollDeletions(at);
    this.primed = true;
  }

  /**
   * Removals recorded by the moderation/deletion tracker.
   *
   * Nothing writes that table yet, so this currently emits nothing — but the
   * path is real end to end, so the day a producer starts recording removals
   * the feed drops them without a code change. A delete for an id the client
   * never received is harmlessly ignored there.
   */
  private async pollDeletions(at: string): Promise<void> {
    const rows = await prisma.deletedOrChangedContentEvents.findMany({
      where: {
        detectedAt: { gt: this.deletionCursor },
        eventType: { in: ["deleted", "removed"] },
      },
      orderBy: { detectedAt: "asc" },
      take: 50,
    });

    for (const row of rows) {
      if (row.detectedAt > this.deletionCursor) this.deletionCursor = row.detectedAt;
      const id = row.redditCommentId ?? row.redditPostId;
      if (!id) continue;
      const type = row.contentType === "comment" ? "deletedComment" : "deletedPost";
      this.fanOut(row.ticker ? [row.ticker] : [], at, (ticker) => ({ type, ticker, at, id }));
    }
  }
}

export const discussionSource = new DatabaseChangeSource(
  env.DISCUSSION_POLL_MS ?? DEFAULT_INTERVAL_MS,
);
