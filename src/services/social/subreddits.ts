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
