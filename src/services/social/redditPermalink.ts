/**
 * Canonical Reddit URLs.
 *
 * The feed's "Open on Reddit" action has to land on the exact thread the row
 * came from, so the API must hand the client a ready-to-use absolute URL. The
 * frontend never builds one — a URL assembled from a title or a username is a
 * guess, and a guess that 404s is worse than no link at all.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * The provider returns `redditUrl`, but the ingestion mapper was reading
 * `postUrl`, `url` and `link` — none of which the payload contains. Every
 * permalink had been silently discarded: 5 of 1,527 stored posts had a URL, and
 * all five were seed rows. Normalizing in one place makes that class of
 * mismatch visible instead of silent.
 */

const REDDIT_HOST = "https://www.reddit.com";

/** Hosts we accept as already-canonical Reddit links. */
const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "m.reddit.com",
  "i.redd.it",
  "v.redd.it",
]);

/**
 * Turn whatever the source gave us into `https://www.reddit.com/...`.
 *
 * Accepts an absolute Reddit URL on any of its host variants, or a bare
 * permalink path. Returns null for anything else — an external link (Reddit
 * posts often carry one), a relative fragment, or junk. Null means the action
 * is omitted, never rendered dead.
 */
export function canonicalRedditUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.length === 0) return null;

  // A bare permalink path: /r/wallstreetbets/comments/abc123/title/
  if (value.startsWith("/")) {
    return `${REDDIT_HOST}${value}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const host = parsed.hostname.toLowerCase();
  if (!REDDIT_HOSTS.has(host)) {
    // An article, image or video hosted elsewhere. Real, but it is not the
    // Reddit thread the row is about, so it must not become "Open on Reddit".
    return null;
  }
  // Media subdomains are canonical as they are; only the site itself is
  // rewritten onto www so every stored link looks the same.
  if (host === "i.redd.it" || host === "v.redd.it") return parsed.toString();

  return `${REDDIT_HOST}${parsed.pathname}${parsed.search}`;
}

/**
 * The permalink for a comment.
 *
 * Reddit comment URLs are the parent thread's path plus the comment id. When
 * the source supplies a comment URL we use it; otherwise we append the id to
 * the parent's permalink, which is exactly how Reddit itself addresses a
 * comment. FALLING BACK TO THE BARE PARENT is the last resort and is honest —
 * the reader lands on the right thread rather than on a 404.
 *
 * @param commentUrl  what the source recorded for the comment, if anything
 * @param parentUrl   the parent post's canonical URL, if known
 * @param commentId   Reddit's id for the comment (`t1_abc123` or `abc123`)
 */
export function canonicalCommentUrl(
  commentUrl: string | null | undefined,
  parentUrl: string | null | undefined,
  commentId?: string | null,
): string | null {
  const direct = canonicalRedditUrl(commentUrl);
  if (direct) return direct;

  const parent = canonicalRedditUrl(parentUrl);
  if (!parent) return null;

  const bare = stripFullnamePrefix(commentId);
  if (!bare) return parent;

  const base = parent.endsWith("/") ? parent : `${parent}/`;
  return `${base}${bare}/`;
}

/** `t3_1vi969l` → `1vi969l`. Reddit's fullnames carry a type prefix. */
export function stripFullnamePrefix(id: string | null | undefined): string | null {
  if (!id) return null;
  const value = id.trim();
  if (value.length === 0) return null;
  return /^t\d_/.test(value) ? value.slice(3) : value;
}

/** Trimmed flair text, or null. Never a placeholder. */
export function normalizeFlair(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  // Reddit flair carries `:emoji_name:` shortcodes that only resolve inside
  // Reddit's own renderer — verbatim they read as ":stonk:", which is noise.
  // Stripping them is normalization, not invention: the words around them are
  // the flair, and a flair that was ONLY shortcodes becomes null so no empty
  // badge appears.
  const cleaned = text
    .replace(/:[a-z0-9_\-]+:/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : null;
}
