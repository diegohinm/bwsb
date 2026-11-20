import { WORKER_PULSE_TIMEFRAMES } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import {
  countStanceMentionGroups,
  saveMarketPulseSnapshot,
  type MarketPulseSnapshotInput,
  type MentionGroup,
} from "../repositories/marketPulse.repository.js";
import {
  computePulseScore,
  FORMULA_VERSION,
  MIN_CLASSIFIED_MENTIONS,
  type StanceCounts,
} from "../services/dashboard/marketPulse.service.js";
import {
  PULSE_TIMEFRAME_MS,
  type PulseTimeframe,
} from "../services/social/socialData.types.js";

/**
 * WORKER JOB — Market Pulse.
 *
 * Produces the Dashboard's 0..100 crowd-direction gauge from what Reddit has
 * actually said about tickers, for every pulse timeframe:
 *
 *   1. count stored ticker mentions (item × distinct ticker) posted inside the
 *      window, grouped by provider / kind / persisted stance — one SQL aggregate
 *      over social_posts + social_comments, every row, no sampling cap
 *   2. drop groups from the mock provider or with no recorded provider: demo
 *      content must never move the gauge
 *   3. apply the formula (services/dashboard/marketPulse.service.ts)
 *   4. append the result, WITH every input count, to market_pulse_snapshots
 *
 * DATABASE ONLY — no provider is called. A window with too few classified
 * mentions is still recorded (score NULL): "the worker looked and there was not
 * enough to say" is a real observation, distinct from "the worker never ran".
 * A database failure throws, so worker_runs records it and the API reports the
 * previous snapshot as stale rather than inventing a fresh one.
 */

const STANCES = new Set(["bullish", "neutral", "bearish"]);

/** A provider whose content may be counted. */
export function isRealProvider(provider: string | null): provider is string {
  return provider != null && provider.trim() !== "" && provider !== "mock";
}

export interface MentionTally {
  stance: StanceCounts;
  mentions: number;
  items: number;
  posts: number;
  comments: number;
  tickers: number;
  subreddits: string[];
  /** Real providers, sorted and joined with "+". Null when none contributed. */
  provider: string | null;
  /** Ticker-bearing items from the mock provider or with no provider. */
  excludedItems: number;
  latestMentionAt: string | null;
}

/** Fold the SQL groups into one tally over REAL content. Pure — exported for tests. */
export function tallyMentionGroups(groups: MentionGroup[]): MentionTally {
  const stance: StanceCounts = { bullish: 0, neutral: 0, bearish: 0, unclassified: 0 };
  const tickers = new Set<string>();
  const subreddits = new Set<string>();
  const providers = new Set<string>();
  let mentions = 0;
  let items = 0;
  let posts = 0;
  let comments = 0;
  let excludedItems = 0;
  let latest: number | null = null;

  for (const g of groups) {
    if (!isRealProvider(g.provider)) {
      excludedItems += g.items;
      continue;
    }
    providers.add(g.provider);

    const s = g.stance?.trim().toLowerCase() ?? null;
    if (s && STANCES.has(s)) stance[s as "bullish" | "neutral" | "bearish"] += g.mentions;
    else stance.unclassified += g.mentions;

    mentions += g.mentions;
    // Every item belongs to exactly one (provider, kind, stance) group, so the
    // per-group distinct item counts add up without double counting.
    items += g.items;
    if (g.kind === "comment") comments += g.items;
    else posts += g.items;

    for (const t of g.tickers) tickers.add(t.toUpperCase());
    for (const sub of g.subreddits) if (sub) subreddits.add(sub);

    const t = g.newest ? Date.parse(g.newest) : NaN;
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }

  return {
    stance,
    mentions,
    items,
    posts,
    comments,
    tickers: tickers.size,
    subreddits: [...subreddits].sort((a, b) => a.localeCompare(b)),
    provider: providers.size ? [...providers].sort().join("+") : null,
    excludedItems,
    latestMentionAt: latest === null ? null : new Date(latest).toISOString(),
  };
}

/** The row to store for one timeframe. Pure — exported for tests. */
export function buildMarketPulseSnapshot(params: {
  groups: MentionGroup[];
  timeframe: PulseTimeframe;
  windowStart: string;
  windowEnd: string;
  minClassified?: number;
}): MarketPulseSnapshotInput {
  const minClassified = params.minClassified ?? MIN_CLASSIFIED_MENTIONS;
  const tally = tallyMentionGroups(params.groups);
  const { score } = computePulseScore(tally.stance, minClassified);

  return {
    timeframe: params.timeframe,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    score,
    bullishCount: tally.stance.bullish,
    neutralCount: tally.stance.neutral,
    bearishCount: tally.stance.bearish,
    unclassifiedCount: tally.stance.unclassified,
    mentionCount: tally.mentions,
    itemCount: tally.items,
    postCount: tally.posts,
    commentCount: tally.comments,
    tickerCount: tally.tickers,
    subreddits: tally.subreddits,
    provider: tally.provider,
    excludedItemCount: tally.excludedItems,
    minClassifiedMentions: minClassified,
    formulaVersion: FORMULA_VERSION,
    latestMentionAt: tally.latestMentionAt,
  };
}

export async function refreshMarketPulse(): Promise<JobMetadata> {
  const now = new Date();
  const snapshotAt = now.toISOString();
  const perTimeframe: Record<string, { score: number | null; classified: number }> = {};

  for (const timeframe of WORKER_PULSE_TIMEFRAMES as readonly PulseTimeframe[]) {
    const since = new Date(now.getTime() - PULSE_TIMEFRAME_MS[timeframe]);
    const groups = await countStanceMentionGroups({ since, until: now });
    const row = buildMarketPulseSnapshot({
      groups,
      timeframe,
      windowStart: since.toISOString(),
      windowEnd: snapshotAt,
    });
    await saveMarketPulseSnapshot(row, snapshotAt);
    perTimeframe[timeframe] = {
      score: row.score,
      classified: row.bullishCount + row.neutralCount + row.bearishCount,
    };
  }

  return { snapshotAt, formulaVersion: FORMULA_VERSION, perTimeframe };
}

// Manual run: npm run pulse:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshMarketPulse", refreshMarketPulse);
}
