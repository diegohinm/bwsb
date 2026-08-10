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

/**
 * WHICH of the three recurring threads a post is.
 *
 * r/wallstreetbets runs them on a schedule and they are different
 * conversations: the morning thread is about the session that is starting, the
 * evening one about the next session, and the weekend one covers two days with
 * no market. Collapsing them into one "daily discussion" throws that away.
 *
 * DECIDED HERE, IN THE WORKER, AND STORED. A `title.includes("tomorrow")` in
 * the browser would see only the rows already fetched, would drift the moment
 * the subreddit rewords a title, and would label an ordinary post that merely
 * mentions tomorrow.
 */
export const DISCUSSION_THREAD_TYPES = ["DAILY", "TOMORROW", "WEEKEND"] as const;
export type DiscussionThreadType = (typeof DISCUSSION_THREAD_TYPES)[number];

export function isDiscussionThreadType(v: unknown): v is DiscussionThreadType {
  return typeof v === "string" && (DISCUSSION_THREAD_TYPES as readonly string[]).includes(v);
}

/**
 * Ordered MOST SPECIFIC FIRST.
 *
 * "What Are Your Moves Tomorrow" must be tested before anything looser, or the
 * evening thread gets filed as the morning one. Each pattern tolerates the date
 * suffix, punctuation and capitalisation every real title carries, while
 * staying anchored so an ordinary post cannot match.
 */
const THREAD_TYPE_PATTERNS: readonly { type: DiscussionThreadType; pattern: RegExp }[] = [
  { type: "WEEKEND", pattern: /^weekend discussion thread\b/ },
  // Some weekends the subreddit uses a "moves" wording instead.
  { type: "WEEKEND", pattern: /^what are your moves this weekend\b/ },
  { type: "TOMORROW", pattern: /^what are your moves tomorrow\b/ },
  { type: "DAILY", pattern: /^what are your moves today\b/ },
  { type: "DAILY", pattern: /^daily discussion thread\b/ },
];

/** Flair is the subreddit's own label, so it beats reading the prose. */
const FLAIR_THREAD_TYPES: Readonly<Record<string, DiscussionThreadType>> = {
  "weekend discussion": "WEEKEND",
  "daily discussion": "DAILY",
};

/**
 * Returns null for every ordinary post — including one whose title merely
 * mentions "tomorrow" — so null can be read as "not a megathread" without a
 * second check.
 */
export function classifyThreadType(
  title: string | null | undefined,
  subreddit: string | null | undefined,
  flair?: string | null,
): DiscussionThreadType | null {
  if (!isDailyDiscussionPost(title, subreddit, flair)) return null;

  // The TITLE is checked first here, unlike the boolean above: a post flaired
  // "Daily Discussion" whose title says "Tomorrow" is the evening thread, and
  // the title is the more specific statement of which one it is.
  if (title) {
    const normalized = normalizeTitle(title);
    for (const { type, pattern } of THREAD_TYPE_PATTERNS) {
      if (pattern.test(normalized)) return type;
    }
  }

  if (flair) {
    const mapped = FLAIR_THREAD_TYPES[flair.trim().toLowerCase()];
    if (mapped) return mapped;
  }

  // Recognized as a megathread (usually by a "Megathread" flair) but matching
  // none of the three title shapes. DAILY is the honest default: it is the
  // everyday thread, and guessing WEEKEND would file weekday content under a
  // heading that says otherwise.
  return "DAILY";
}
