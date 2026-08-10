/**
 * THE DISCUSSION EVENT VOCABULARY.
 *
 * This is the contract between whatever is producing Reddit activity and
 * whatever is displaying it. It is deliberately provider-neutral: nothing here
 * names Mindcase, Arctic Shift or the Reddit API, so a future push-based source
 * can replace the current one without the socket layer or the frontend changing
 * a line.
 *
 * Author identity is a HASH, never a username. Both ingestion paths store
 * `anon_<12 hex>` and the raw name is not kept anywhere, so the feed shows a
 * stable pseudonymous handle and links out to Reddit for the real one.
 */

export const DISCUSSION_EVENT_TYPES = [
  "newPost",
  "updatedPost",
  "newComment",
  "updatedComment",
  "deletedPost",
  "deletedComment",
] as const;

export type DiscussionEventType = (typeof DISCUSSION_EVENT_TYPES)[number];

/** The final classification only — never a confidence score or a percentage. */
export type DiscussionSentiment = "bullish" | "neutral" | "bearish";

/**
 * A security the content refers to, already validated and scored server-side.
 *
 * The frontend renders this and nothing else — it never scans title or body for
 * uppercase words. Detection happens once during ingestion, against the ticker
 * catalog, and is stored; see services/extraction/tickerExtraction.service.ts.
 *
 * `confidence` is carried so a client can reason about strength if it ever
 * needs to, but the API has already dropped everything below the display
 * threshold: an item that reaches here is one we are prepared to show.
 */
export interface DiscussionTicker {
  symbol: string;
  companyName: string | null;
  confidence: number;
}

export interface DiscussionPost {
  id: string;
  ticker: string;
  subreddit: string;
  /** Anonymized, stable per author. Not a Reddit username. */
  author: string;
  title: string;
  /** A short excerpt only — the full post is read on Reddit. */
  preview: string;
  upvotes: number | null;
  commentCount: number | null;
  sentiment: DiscussionSentiment;
  /** Validated securities this post refers to. Empty when none was confident. */
  tickers: DiscussionTicker[];
  /**
   * Subreddit link flair, or null. Never a placeholder — the badge is omitted.
   */
  flairText: string | null;
  /**
   * Ready-to-use canonical Reddit URL, or null. The client never builds one:
   * a URL assembled from a title is a guess, and a guess that 404s is worse
   * than no link.
   */
  redditUrl: string | null;
  /** The original Reddit URL. Null when the source stored none. */
  permalink: string | null;
  createdAt: string;
}

export interface DiscussionComment {
  id: string;
  ticker: string;
  /** The post this comment belongs to, when the source recorded it. */
  postId: string | null;
  subreddit: string;
  author: string;
  preview: string;
  score: number | null;
  /** Replies to this comment, when the source recorded it. */
  replyCount: number | null;
  sentiment: DiscussionSentiment;
  tickers: DiscussionTicker[];
  flairText: string | null;
  /** The comment's own permalink, or its parent thread as an honest fallback. */
  redditUrl: string | null;
  permalink: string | null;
  createdAt: string;
}

export type DiscussionEvent =
  | { type: "newPost" | "updatedPost"; ticker: string; at: string; post: DiscussionPost }
  | {
      type: "newComment" | "updatedComment";
      ticker: string;
      at: string;
      comment: DiscussionComment;
    }
  | { type: "deletedPost" | "deletedComment"; ticker: string; at: string; id: string };

/** The frame a client receives. `hello` carries the stream's own metadata. */
export type DiscussionFrame =
  | {
      kind: "hello";
      ticker: string;
      transport: "websocket" | "sse";
      /** How the events are being produced, for the status bar. */
      sourceMode: string;
      pollIntervalMs: number;
    }
  | { kind: "event"; event: DiscussionEvent }
  | { kind: "heartbeat"; at: string };

/**
 * Map a stored stance to the three-way classification.
 *
 * An unread or unrecognized stance becomes `neutral` because the badge has only
 * three states — but note this is a DISPLAY fallback, not a claim that the
 * crowd was undecided. Aggregates elsewhere in the app keep unclassified items
 * out of their percentages for exactly that reason.
 */
export function toSentiment(stance: string | null | undefined): DiscussionSentiment {
  if (stance === "bullish" || stance === "bearish") return stance;
  return "neutral";
}

/** First few lines of a body, for the card preview. Never the whole post. */
export function toPreview(body: string | null | undefined, maxChars = 240): string {
  if (!body) return "";
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars).trimEnd()}…`;
}

/**
 * A short, stable handle from the stored hash.
 *
 * `anon_a3f91c2d5e07` → `anon_a3f91c`. It identifies the same person across
 * items — which is what makes a feed readable — without pretending to be their
 * Reddit username, because that name is not stored and cannot be recovered.
 */
export function toAuthorHandle(authorHash: string | null | undefined): string {
  if (!authorHash) return "anon";
  return authorHash.startsWith("anon_") ? authorHash.slice(0, 11) : authorHash.slice(0, 12);
}
