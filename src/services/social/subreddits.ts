/**
 * The investing subreddits YOLOPulse tracks. Single source of truth — the Pulse
 * page, the mock fixtures and any future provider all read this list so adding a
 * community is a one-line change.
 */

export type TrackedSubreddit = {
  /** Canonical name without the `r/` prefix. Matches Reddit's own casing. */
  name: string;
  /** Short human label used in dense UI (heatmap axes, chips). */
  shortLabel: string;
  /** What the community is about — shown as a tooltip/subtitle. */
  blurb: string;
};

export const TRACKED_SUBREDDITS: readonly TrackedSubreddit[] = [
  {
    name: "wallstreetbets",
    shortLabel: "WSB",
    blurb: "High-conviction options plays and loss porn.",
  },
  {
    name: "stocks",
    shortLabel: "STOCKS",
    blurb: "General equity discussion and earnings reactions.",
  },
  {
    name: "investing",
    shortLabel: "INVEST",
    blurb: "Long-horizon portfolio and macro talk.",
  },
  {
    name: "options",
    shortLabel: "OPTIONS",
    blurb: "Greeks, spreads and volatility structure.",
  },
  {
    name: "pennystocks",
    shortLabel: "PENNY",
    blurb: "Sub-$5 momentum and microcap speculation.",
  },
  {
    name: "Shortsqueeze",
    shortLabel: "SQUEEZE",
    blurb: "Short interest, utilization and squeeze setups.",
  },
  {
    name: "ValueInvesting",
    shortLabel: "VALUE",
    blurb: "Fundamentals, moats and margin of safety.",
  },
  {
    name: "SecurityAnalysis",
    shortLabel: "ANALYSIS",
    blurb: "Deep-dive write-ups and financial statement work.",
  },
] as const;

export const TRACKED_SUBREDDIT_NAMES: readonly string[] =
  TRACKED_SUBREDDITS.map((s) => s.name);

export function displayName(subreddit: string): string {
  return `r/${subreddit}`;
}

/** Canonical name by lowercased name — Reddit names are case-insensitive. */
const CANONICAL_BY_LOWER = new Map(
  TRACKED_SUBREDDITS.map((s) => [s.name.toLowerCase(), s.name]),
);

/**
 * Canonical form of a user-supplied subreddit name, or null when it is not a
 * tracked community. Tolerates `r/`, `/r/`, surrounding whitespace and any
 * casing, so a hand-edited URL can't produce a name the aggregator won't match.
 */
export function normalizeSubreddit(raw: string): string | null {
  const cleaned = raw.trim().replace(/^\/?r\//i, "").trim();
  if (!cleaned) return null;
  return CANONICAL_BY_LOWER.get(cleaned.toLowerCase()) ?? null;
}

/**
 * Parse a `subreddits=a,b,c` filter into canonical tracked names.
 *
 * Invalid/unknown entries are dropped silently, and a filter that survives with
 * nothing in it returns `undefined` — meaning "no filter", i.e. all communities.
 * The result is always in TRACKED order and de-duplicated, so two spellings of
 * the same selection produce byte-identical downstream keys.
 */
export function parseSubredditFilter(
  raw: string | null | undefined,
): string[] | undefined {
  if (!raw) return undefined;
  const wanted = new Set<string>();
  for (const part of raw.split(",")) {
    const name = normalizeSubreddit(part);
    if (name) wanted.add(name);
  }
  if (wanted.size === 0) return undefined;
  return TRACKED_SUBREDDIT_NAMES.filter((n) => wanted.has(n));
}
