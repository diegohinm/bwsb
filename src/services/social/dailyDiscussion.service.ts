/**
 * Recognizing r/wallstreetbets daily discussion threads.
 *
 * These are the recurring megathreads the subreddit posts on a schedule — the
 * ones where most day-to-day chatter actually happens, rather than in the
 * comments of individual posts. Their titles carry the date, so nothing here
 * may compare against a specific one: today's thread is tomorrow's history and
 * the post id changes daily.
 *
 * WHERE THIS RUNS
 *
 * At INGESTION, once per post, and the answer is stored in
 * `social_posts.post_category`. Not at read time and never in the browser: a
 * title match on the hot path cannot use an index, and a match in the frontend
 * would only ever see the page of rows already fetched, so counts, ordering and
 * pagination would all be wrong.
 *
 * SCOPE
 *
 * r/wallstreetbets only, deliberately. Other subreddits run their own
 * megathreads with colliding names ("Daily Discussion Thread" exists in half a
 * dozen finance subs), and treating those as the same feature would silently
 * mix communities. Widening this is a one-line change to SUPPORTED_SUBREDDITS
 * plus a decision about what the filter then means.
 */

export const POST_CATEGORIES = ["REGULAR", "DAILY_DISCUSSION"] as const;
export type PostCategory = (typeof POST_CATEGORIES)[number];

export function isPostCategory(value: unknown): value is PostCategory {
  return typeof value === "string" && (POST_CATEGORIES as readonly string[]).includes(value);
}

/** The only community whose daily threads this feature recognizes. */
export const DAILY_DISCUSSION_SUBREDDIT = "wallstreetbets";

/**
 * How far back a thread may be and still count as "current".
 *
 * The "tomorrow" thread is posted the previous evening and a weekend thread
 * has to carry Saturday and Sunday, so a window shorter than two days would
 * leave the filter empty for most of a weekend. Anything older than this is
 * history, not the active thread.
 */
export const DAILY_DISCUSSION_WINDOW_HOURS = 48;

/**
 * Title patterns, anchored at the start.
 *
 * The anchor matters: "My thoughts on the daily discussion thread" is an
 * ordinary post that happens to mention one, and an unanchored pattern would
 * pull it and its comments into the feed.
 *
 * `\b` after each phrase keeps "daily discussion threadbare" out while still
 * allowing the date suffix that every real title carries.
 */
const TITLE_PATTERNS: readonly RegExp[] = [
  /^what are your moves tomorrow\b/,
  /^what are your moves today\b/,
  /^daily discussion thread\b/,
  /^weekend discussion thread\b/,
];

/** Flairs some sources attach; checked before the title when present. */
const DAILY_FLAIRS = new Set(["daily discussion", "weekend discussion", "megathread"]);

/** Collapse whitespace and case so formatting differences cannot matter. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Is this post one of r/wallstreetbets' recurring discussion threads?
 *
 * `flair` is honoured first when a source provides one — it is the subreddit's
 * own classification, which beats inferring from prose — but it is optional,
 * because the current provider does not return it for every item.
 */
export function isDailyDiscussionPost(
  title: string | null | undefined,
  subreddit: string | null | undefined,
  flair?: string | null,
): boolean {
  if (!subreddit || subreddit.trim().toLowerCase() !== DAILY_DISCUSSION_SUBREDDIT) {
    return false;
  }

  if (flair && DAILY_FLAIRS.has(flair.trim().toLowerCase())) return true;

  if (!title) return false;
  const normalized = normalizeTitle(title);
  return TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** The value stored in `social_posts.post_category`. */
export function classifyPostCategory(
  title: string | null | undefined,
  subreddit: string | null | undefined,
  flair?: string | null,
): PostCategory {
  return isDailyDiscussionPost(title, subreddit, flair) ? "DAILY_DISCUSSION" : "REGULAR";
}
