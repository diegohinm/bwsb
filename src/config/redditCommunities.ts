import { TRACKED_SUBREDDIT_NAMES } from "../services/social/subreddits.js";

/**
 * THE SINGLE SOURCE OF TRUTH FOR WHICH REDDIT COMMUNITIES ARE ACTIVE.
 *
 * One variable, in the backend, decides everything:
 *
 *     REDDIT_ACTIVE_COMMUNITIES=wallstreetbets
 *              │
 *              ├─ backend   Discussion, search, summary, Top/Hot tickers
 *              ├─ worker    which subreddits Mindcase is ever asked about
 *              └─ frontend  which communities exist, and whether a selector shows
 *
 * The worker and the frontend read it THROUGH THE BACKEND (runtime-config
 * endpoints); neither has an environment variable of its own. That is the whole
 * point: three places to configure one fact is three chances to disagree, and
 * the way they disagreed last time cost money.
 *
 * SUPPORTED ≠ ACTIVE, and conflating them is exactly the bug this replaces.
 * `REDDIT_SUBREDDITS` was one list meaning both "communities the product knows
 * about" and "communities we pay a metered provider for", so every community
 * added for display silently multiplied the Mindcase bill. Multi-community
 * support is NOT removed — it is simply no longer the same question as "what do
 * we ingest".
 */

/**
 * Every community the product knows how to handle.
 *
 * Derived from the tracked-subreddit catalog rather than restated, so a
 * community cannot be activatable without also being displayable. Lowercased
 * here because Reddit names are case-insensitive and the catalog stores Reddit's
 * own casing (`Shortsqueeze`, `ValueInvesting`).
 */
export const SUPPORTED_REDDIT_COMMUNITIES: readonly string[] = Object.freeze(
  [...new Set(TRACKED_SUBREDDIT_NAMES.map((n) => n.trim().toLowerCase()))].filter(Boolean),
);

/**
 * The safe fallback when the variable is absent.
 *
 * ONE COMMUNITY, NEVER "ALL". An unset variable is an unknown intent, and the
 * cheap reading of an unknown intent is the correct one: resolving it to the
 * full supported list would turn a missing line in a `.env` into eight metered
 * subreddits. Discussion is WSB-only today, so WSB is both the safe answer and
 * the right one.
 */
export const DEFAULT_ACTIVE_COMMUNITY = "wallstreetbets";

/** Raised on a community that is not in the supported catalog. */
export class InvalidRedditCommunityError extends Error {
  constructor(readonly community: string) {
    super(
      `Invalid Reddit community configured: ${community}. ` +
        `REDDIT_ACTIVE_COMMUNITIES accepts only: ${SUPPORTED_REDDIT_COMMUNITIES.join(", ")}.`,
    );
    this.name = "InvalidRedditCommunityError";
  }
}

/**
 * `  R/WallStreetBets/ ` → `wallstreetbets`.
 *
 * Accepts what somebody plausibly pastes into an env file: a full URL, an `r/`
 * prefix, mixed case, stray whitespace, a trailing slash.
 */
export function normalizeCommunity(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(www\.)?reddit\.com/i, "")
    .replace(/^\/+/, "")
    .replace(/^r\//i, "")
    .replace(/\/.*$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Parse the variable into the active list.
 *
 * FAILS FAST on an unrecognized community rather than dropping it. A silently
 * ignored typo is the worst outcome available here: the operator believes
 * `wallstreetbets,optionz` activated two communities, the system quietly
 * activates one, and nothing says so until somebody compares a dashboard
 * against an invoice. A refused startup is loud and immediate.
 *
 * An EMPTY or absent value is not an error — it is simply the default. That
 * distinction matters: "I did not configure this" is a normal state for a fresh
 * environment, while "I configured something meaningless" is a mistake.
 */
export function parseRedditCommunities(raw: string | undefined): string[] {
  const communities = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map(normalizeCommunity)
        .filter(Boolean),
    ),
  ];

  if (communities.length === 0) return [DEFAULT_ACTIVE_COMMUNITY];

  for (const community of communities) {
    if (!SUPPORTED_REDDIT_COMMUNITIES.includes(community)) {
      throw new InvalidRedditCommunityError(community);
    }
  }

  return communities;
}

/**
 * THE ACTIVE LIST. Read once, at module load, so every consumer in the process
 * sees the same answer and an invalid value stops startup rather than surfacing
 * on the first request that happens to touch it.
 */
export const ACTIVE_REDDIT_COMMUNITIES: readonly string[] = Object.freeze(
  parseRedditCommunities(process.env.REDDIT_ACTIVE_COMMUNITIES),
);

/**
 * DERIVED, never configured.
 *
 * A separate `ALLOW_COMMUNITY_SELECTION` variable could contradict the list it
 * describes — one community and a visible selector, or five and no way to pick.
 * There is exactly one situation in which choosing is meaningful.
 */
export const ALLOW_REDDIT_COMMUNITY_SELECTION: boolean =
  ACTIVE_REDDIT_COMMUNITIES.length > 1;

/**
 * Narrow a caller's request down to what is actually active.
 *
 * THE ENFORCEMENT POINT. Every read path funnels through this, so a query
 * string cannot widen scope no matter what it asks for:
 *
 *     active ["wallstreetbets"], requested ["options"]  → ["wallstreetbets"]
 *     active ["wallstreetbets"], requested undefined    → ["wallstreetbets"]
 *     active ["wsb","options"],  requested ["options"]  → ["options"]
 *     active ["wsb","options"],  requested ["stocks"]   → ["wsb","options"]
 *
 * INTERSECTION, WITH A FLOOR. An intersection alone would return an empty list
 * for an inactive community, and an empty list is ambiguous downstream — the
 * filter builders read "no communities" as "every community", which is the
 * precise inversion this function exists to prevent. So a request that selects
 * nothing active falls back to the full active set rather than to nothing.
 */
export function resolveEffectiveRedditCommunities(
  requested?: readonly string[] | null,
): string[] {
  const active = [...ACTIVE_REDDIT_COMMUNITIES];
  if (!requested || requested.length === 0) return active;

  const normalized = new Set(requested.map(normalizeCommunity).filter(Boolean));
  const allowed = active.filter((community) => normalized.has(community));

  return allowed.length > 0 ? allowed : active;
}

/** True when this community may be talked to at all. Used by the cost guard. */
export function isActiveCommunity(community: string): boolean {
  return ACTIVE_REDDIT_COMMUNITIES.includes(normalizeCommunity(community));
}

export type RedditCommunityOption = {
  id: string;
  /** What a human sees. The catalog's casing, prefixed. */
  label: string;
};

/** Display labels for the active communities, for the public config endpoint. */
export function activeCommunityOptions(): RedditCommunityOption[] {
  const byLower = new Map(TRACKED_SUBREDDIT_NAMES.map((n) => [n.toLowerCase(), n]));
  return ACTIVE_REDDIT_COMMUNITIES.map((id) => ({
    id,
    label: `r/${byLower.get(id) ?? id}`,
  }));
}

/** The mandatory startup line. Makes "supported vs active" visible at a glance. */
export function describeRedditCommunities(): string {
  return (
    `[reddit-config] supported=${SUPPORTED_REDDIT_COMMUNITIES.join(",")} ` +
    `active=${ACTIVE_REDDIT_COMMUNITIES.join(",")} ` +
    `communitySelection=${ALLOW_REDDIT_COMMUNITY_SELECTION}`
  );
}

/**
 * Query string → the communities a request may actually read.
 *
 * THE ENFORCEMENT BOUNDARY for every HTTP surface. Routes call this instead of
 * a plain parser, so `?communities=options` cannot widen scope — the clamp
 * happens where the untrusted value enters, not somewhere downstream that a
 * future caller might bypass.
 *
 * It never returns `undefined`. The filter builders read "no communities" as
 * "every community", so handing them nothing would invert the guarantee this
 * function exists to provide: an unscoped query must mean ALL ACTIVE, never ALL
 * STORED. Historical rows from communities that are no longer active stay in the
 * database and stop being read — they are not deleted, just out of scope.
 */
export function effectiveCommunitiesFromQuery(raw: string | null | undefined): string[] {
  if (!raw) return [...ACTIVE_REDDIT_COMMUNITIES];
  return resolveEffectiveRedditCommunities(raw.split(","));
}
