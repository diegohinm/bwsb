import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
} from "./types.js";

/**
 * Upstream payload → canonical record.
 *
 * This is the seam that keeps every provider-specific field name inside
 * `src/providers/reddit/`. Two upstreams describe the same Reddit post with
 * different keys (`selftext` vs `text`, `num_comments` vs `comments`,
 * `created_utc` seconds vs an ISO string); after normalization the difference
 * is gone and the merge logic in deduplicateRedditData.ts can treat both as the
 * same record.
 *
 * ID RULE — the whole deduplication scheme depends on it:
 *   posts     `t3_abc123` and `abc123` both normalize to `abc123`
 *   comments  `t1_xyz789` and `xyz789` both normalize to `xyz789`
 * The `t3_`/`t1_` form is preserved separately as `fullname`.
 *
 * Every normalizer is total: it returns `null` for a record with no usable id
 * rather than throwing, so one malformed row never sinks a page of results.
 */

export interface NormalizeContext {
  /** Subreddit to attribute the record to when the payload omits it. */
  subreddit?: string;
  /** When this batch was retrieved. Defaults to now. */
  fetchedAt?: Date;
}

/** Author values that mean "there is no author", not "the author is named X". */
const EMPTY_AUTHORS = new Set(["[deleted]", "[removed]", "deleted", "removed", "none"]);
/** Body values that mean "there is no body". */
const EMPTY_BODIES = new Set(["[deleted]", "[removed]"]);

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : null;
}

/** First present non-empty string among `keys`. */
function str(raw: Raw, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** First present finite number among `keys` (accepts numeric strings). */
function num(raw: Raw, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Strip a Reddit type prefix. `t3_abc123` → `abc123`, `abc123` → `abc123`.
 * Exported because the providers use it when echoing a caller-supplied postId.
 */
export function toBareId(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed.replace(/^t[1-6]_/i, "");
  return stripped.length > 0 ? stripped : null;
}

/** `abc123` + `t3` → `t3_abc123`; an already-prefixed value is returned as-is. */
export function toFullname(
  value: string | undefined | null,
  prefix: "t1" | "t3",
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return /^t[1-6]_/i.test(trimmed) ? trimmed : `${prefix}_${trimmed}`;
}

/** Deleted/removed/blank authors become null — they are not identities. */
function authorOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return EMPTY_AUTHORS.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** Missing/blank/tombstoned text becomes null rather than an empty string. */
function textOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return EMPTY_BODIES.has(trimmed.toLowerCase()) ? null : value;
}

/**
 * Any timestamp shape the upstreams use → Date.
 *
 * Reddit's `created_utc` is seconds; Mindcase sometimes sends an ISO string and
 * sometimes milliseconds. Values are disambiguated by magnitude: anything past
 * ~1e12 is already milliseconds.
 */
export function toDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(trimmed)) {
      return new Date(asNumber > 1e12 ? asNumber : asNumber * 1000);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }

  return fallback;
}

/**
 * Reddit permalink path. Prefers what the upstream sent; otherwise rebuilds the
 * canonical `/r/<sub>/comments/<postId>/` form, which is a valid Reddit URL.
 */
function buildPostPermalink(
  supplied: string | undefined,
  subreddit: string,
  postId: string,
): string {
  const normalized = normalizePermalink(supplied);
  if (normalized) return normalized;
  return `/r/${subreddit}/comments/${postId}/`;
}

function buildCommentPermalink(
  supplied: string | undefined,
  subreddit: string,
  postId: string | null,
  commentId: string,
): string | null {
  const normalized = normalizePermalink(supplied);
  if (normalized) return normalized;
  if (!subreddit || !postId) return null;
  return `/r/${subreddit}/comments/${postId}/_/${commentId}/`;
}

/** Reduce an absolute reddit.com URL to its path; keep other paths as given. */
function normalizePermalink(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("/")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (/(^|\.)reddit\.com$/i.test(parsed.hostname)) return parsed.pathname;
  } catch {
    /* not a URL — fall through */
  }
  return trimmed;
}

/** Subreddit without the `r/` prefix. */
function cleanSubreddit(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback;
  return (candidate ?? "").replace(/^\/?r\//i, "").trim();
}

// ── Arctic Shift ─────────────────────────────────────────────────────────────

/**
 * Arctic Shift mirrors Reddit's own JSON field names (it is a Pushshift-style
 * archive), so this is close to a straight rename.
 */
export function normalizeArcticShiftPost(
  input: unknown,
  context: NormalizeContext = {},
): NormalizedRedditPost | null {
  const raw = asRecord(input);
  if (!raw) return null;

  const externalId = toBareId(str(raw, "id", "name", "post_id"));
  if (!externalId) return null;

  const fetchedAt = context.fetchedAt ?? new Date();
  const subreddit = cleanSubreddit(str(raw, "subreddit"), context.subreddit ?? "");
  const title = str(raw, "title") ?? "";

  return {
    externalId,
    fullname: toFullname(str(raw, "name") ?? externalId, "t3"),
    subreddit,
    author: authorOrNull(str(raw, "author")),
    title,
    body: textOrNull(str(raw, "selftext")),
    permalink: buildPostPermalink(str(raw, "permalink"), subreddit, externalId),
    url: str(raw, "url") ?? null,
    score: num(raw, "score", "ups") ?? 0,
    upvoteRatio: num(raw, "upvote_ratio") ?? null,
    commentCount: num(raw, "num_comments") ?? 0,
    createdAt: toDate(raw.created_utc ?? raw.created, fetchedAt),
    fetchedAt,
    primarySource: "arctic_shift",
    sources: ["arctic_shift"],
    raw,
  };
}

export function normalizeArcticShiftComment(
  input: unknown,
  context: NormalizeContext = {},
): NormalizedRedditComment | null {
  const raw = asRecord(input);
  if (!raw) return null;

  const externalId = toBareId(str(raw, "id", "name", "comment_id"));
  if (!externalId) return null;

  const fetchedAt = context.fetchedAt ?? new Date();
  const subreddit = cleanSubreddit(str(raw, "subreddit"), context.subreddit ?? "");
  const postId = toBareId(str(raw, "link_id", "post_id", "parent_post_id"));

  return {
    externalId,
    fullname: toFullname(str(raw, "name") ?? externalId, "t1"),
    postId: postId ?? "",
    parentId: str(raw, "parent_id") ?? null,
    subreddit,
    author: authorOrNull(str(raw, "author")),
    body: textOrNull(str(raw, "body")),
    permalink: buildCommentPermalink(
      str(raw, "permalink"),
      subreddit,
      postId,
      externalId,
    ),
    score: num(raw, "score", "ups") ?? 0,
    createdAt: toDate(raw.created_utc ?? raw.created, fetchedAt),
    fetchedAt,
    primarySource: "arctic_shift",
    sources: ["arctic_shift"],
    raw,
  };
}

// ── Mindcase ─────────────────────────────────────────────────────────────────

/**
 * Mindcase returns an agent-shaped record whose keys vary between skills and
 * account versions, so every field is read through a list of candidates. This
 * defensiveness is deliberate: a renamed key must degrade one field, not drop
 * the record.
 */
export function normalizeMindcasePost(
  input: unknown,
  context: NormalizeContext = {},
): NormalizedRedditPost | null {
  const raw = asRecord(input);
  if (!raw) return null;

  const externalId = toBareId(str(raw, "postId", "post_id", "id", "name"));
  if (!externalId) return null;

  const fetchedAt = context.fetchedAt ?? new Date();
  const subreddit = cleanSubreddit(
    str(raw, "subreddit", "community"),
    context.subreddit ?? "",
  );

  return {
    externalId,
    fullname: toFullname(str(raw, "name") ?? externalId, "t3"),
    subreddit,
    author: authorOrNull(str(raw, "author", "username", "user")),
    title: str(raw, "title", "postTitle") ?? "",
    body: textOrNull(str(raw, "selftext", "text", "body", "content")),
    permalink: buildPostPermalink(
      str(raw, "permalink", "postUrl", "url", "link"),
      subreddit,
      externalId,
    ),
    url: str(raw, "url", "postUrl", "link") ?? null,
    score: num(raw, "score", "upvotes", "ups") ?? 0,
    upvoteRatio: num(raw, "upvoteRatio", "upvote_ratio") ?? null,
    commentCount:
      num(raw, "commentCount", "numComments", "num_comments", "comments") ?? 0,
    createdAt: toDate(
      raw.created_utc ?? raw.createdAt ?? raw.posted ?? raw.created,
      fetchedAt,
    ),
    fetchedAt,
    primarySource: "mindcase",
    sources: ["mindcase"],
    raw,
  };
}

export function normalizeMindcaseComment(
  input: unknown,
  context: NormalizeContext = {},
): NormalizedRedditComment | null {
  const raw = asRecord(input);
  if (!raw) return null;

  const externalId = toBareId(str(raw, "commentId", "comment_id", "id", "name"));
  if (!externalId) return null;

  const fetchedAt = context.fetchedAt ?? new Date();
  const subreddit = cleanSubreddit(
    str(raw, "subreddit", "community"),
    context.subreddit ?? "",
  );
  const postId = toBareId(str(raw, "postId", "post_id", "link_id", "parentPostId"));

  return {
    externalId,
    fullname: toFullname(str(raw, "name") ?? externalId, "t1"),
    postId: postId ?? "",
    parentId: str(raw, "parent_id", "parentId") ?? null,
    subreddit,
    author: authorOrNull(str(raw, "author", "username", "user")),
    body: textOrNull(str(raw, "body", "commentText", "comment", "text")),
    permalink: buildCommentPermalink(
      str(raw, "permalink", "commentUrl", "url"),
      subreddit,
      postId,
      externalId,
    ),
    score: num(raw, "score", "upvotes", "ups") ?? 0,
    createdAt: toDate(
      raw.created_utc ?? raw.createdAt ?? raw.posted ?? raw.created,
      fetchedAt,
    ),
    fetchedAt,
    primarySource: "mindcase",
    sources: ["mindcase"],
    raw,
  };
}

// ── Batch helpers ────────────────────────────────────────────────────────────

type PostNormalizer = (
  input: unknown,
  context: NormalizeContext,
) => NormalizedRedditPost | null;

type CommentNormalizer = (
  input: unknown,
  context: NormalizeContext,
) => NormalizedRedditComment | null;

/** Normalize a page, silently dropping records with no usable id. */
export function normalizePosts(
  records: unknown[],
  normalizer: PostNormalizer,
  context: NormalizeContext = {},
): NormalizedRedditPost[] {
  const out: NormalizedRedditPost[] = [];
  for (const record of records) {
    const post = normalizer(record, context);
    if (post) out.push(post);
  }
  return out;
}

export function normalizeComments(
  records: unknown[],
  normalizer: CommentNormalizer,
  context: NormalizeContext = {},
): NormalizedRedditComment[] {
  const out: NormalizedRedditComment[] = [];
  for (const record of records) {
    const comment = normalizer(record, context);
    if (comment) out.push(comment);
  }
  return out;
}
