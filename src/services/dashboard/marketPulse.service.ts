import { env } from "../../config/env.js";
import {
  readLatestMarketPulse,
  type StoredMarketPulse,
} from "../../repositories/marketPulse.repository.js";
import type { PulseTimeframe } from "../social/socialData.types.js";
import { netSentimentLabel } from "../tickers/tickerMentionSentiment.service.js";

/**
 * MARKET PULSE — the Dashboard's 0..100 crowd-direction gauge.
 *
 * WHAT IT MEASURES. Which way retail leans on the tickers it is talking about,
 * from stored Reddit content and nothing else. No AI, no market data, no
 * editorial input: the score is arithmetic over counts the worker read from
 * `social_posts` / `social_comments`.
 *
 * THE FORMULA (FORMULA_VERSION "stance-net-v1").
 *
 *   unit        one MENTION = one (Reddit item, distinct ticker) pair, taken
 *               from the item's sanitized ticker associations (`tickers[]`).
 *               A comment naming NVDA three times is one NVDA mention; a post
 *               naming NVDA and AMD is two mentions. Only items from a real
 *               social provider count — the mock provider is excluded.
 *   direction   each mention carries its item's persisted `stance`
 *               (bullish | neutral | bearish), the same rule-based column the
 *               ticker pages use. A mention with no recognised stance is
 *               "unclassified" and stays OUT of the denominator.
 *   pooling     counts are pooled across every ticker, so each ticker weighs in
 *               proportion to its mention volume — a name with 400 mentions
 *               moves the gauge forty times more than one with 10.
 *
 *     B, N, R   = bullish, neutral, bearish mentions in the window
 *     C         = B + N + R  (classified mentions)
 *     net       = (B − R) ÷ C                       ∈ [−1, 1]
 *     score     = round(50 + 50 × net)              ∈ [0, 100]
 *
 *   50 is a balanced crowd, 100 every classified mention bullish, 0 every one
 *   bearish. Neutral mentions dilute the tilt toward 50 — most chatter is not
 *   a directional call, and the gauge should not pretend otherwise.
 *
 *   MINIMUM SAMPLE: with C < MIN_CLASSIFIED_MENTIONS the score is NULL and the
 *   panel says there is not enough data. A tilt measured on a dozen comments is
 *   noise, and showing it as a needle would present noise as a reading.
 *
 * LABELS. The band is a pure function of the visible score, using the SAME
 * thresholds as the ticker pages' net-sentiment label (net = 2 × (score − 50)):
 *
 *     75..100 Strong Bullish · 60..74 Bullish · 41..59 Mixed
 *     26..40  Bearish        · 0..25  Strong Bearish
 *
 * The description is built from the stored counts — shares and sample size —
 * never from a canned sentence about what traders are "loading".
 *
 * READ PATH. Database only, one query: the newest `market_pulse_snapshots` row
 * for the timeframe. The worker (jobs/refreshMarketPulse.job.ts) is the only
 * writer; nothing here counts, and nothing here calls a provider.
 */

export const FORMULA_VERSION = "stance-net-v1";
export const FORMULA_EXPRESSION =
  "score = round(50 + 50 × (bullish − bearish) ÷ (bullish + neutral + bearish))";

/** Below this many classified mentions no score is published. */
export const MIN_CLASSIFIED_MENTIONS = 30;

export type MarketPulseTone = "bullish" | "bearish" | "neutral";

/**
 *   ok            a score exists and the snapshot is fresh
 *   stale         a score exists but the worker has not refreshed it in time
 *   insufficient  the worker measured, but too few classified mentions
 *   empty         the worker has never published a Market Pulse snapshot
 */
export type MarketPulseStatus = "ok" | "stale" | "insufficient" | "empty";

export interface StanceCounts {
  bullish: number;
  neutral: number;
  bearish: number;
  /** Mentions whose item had no recognised stance. Not in the score. */
  unclassified: number;
}

export interface PulseScore {
  /** 0..100, null when the sample is below the minimum. */
  score: number | null;
  /** Integer −100..100 net tilt (bullish% − bearish% of classified), null likewise. */
  netSentiment: number | null;
  classified: number;
}

/** The formula, in one place. Pure — the worker stores what this returns. */
export function computePulseScore(
  c: StanceCounts,
  minClassified: number = MIN_CLASSIFIED_MENTIONS,
): PulseScore {
  const classified = c.bullish + c.neutral + c.bearish;
  if (classified <= 0 || classified < minClassified) {
    return { score: null, netSentiment: null, classified };
  }
  const net = (c.bullish - c.bearish) / classified;
  return {
    score: Math.round(50 + 50 * net),
    netSentiment: Math.round(100 * net),
    classified,
  };
}

/** Band name for a visible score — same thresholds as `netSentimentLabel`. */
export function pulseBand(score: number): string {
  return netSentimentLabel(2 * (score - 50));
}

export function pulseTone(score: number): MarketPulseTone {
  if (score >= 60) return "bullish";
  if (score <= 40) return "bearish";
  return "neutral";
}

export interface StanceShares {
  bullish: number;
  neutral: number;
  bearish: number;
}

/**
 * Whole-number shares of the classified mentions that always sum to 100
 * (largest-remainder rounding), or null when nothing was classified — 0/0/0
 * would claim a measured split of nothing.
 */
export function stanceShares(c: StanceCounts): StanceShares | null {
  const total = c.bullish + c.neutral + c.bearish;
  if (total <= 0) return null;
  const parts = [
    { key: "bullish" as const, raw: (c.bullish / total) * 100 },
    { key: "neutral" as const, raw: (c.neutral / total) * 100 },
    { key: "bearish" as const, raw: (c.bearish / total) * 100 },
  ].map((p) => ({ ...p, floor: Math.floor(p.raw), rem: p.raw - Math.floor(p.raw) }));

  let leftover = 100 - parts.reduce((s, p) => s + p.floor, 0);
  // Stable tie-break (bullish, neutral, bearish) keeps the result reproducible.
  const order = [...parts].sort((a, b) => b.rem - a.rem);
  const out: StanceShares = { bullish: 0, neutral: 0, bearish: 0 };
  for (const p of parts) out[p.key] = p.floor;
  for (const p of order) {
    if (leftover <= 0) break;
    out[p.key] += 1;
    leftover -= 1;
  }
  return out;
}

const WINDOW_PHRASE: Record<PulseTimeframe, string> = {
  "1h": "the last hour",
  "6h": "the last 6h",
  "24h": "the last 24h",
  "7d": "the last 7 days",
};

const fmtInt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ── Response contract ────────────────────────────────────────────────────────

export interface MarketPulseCounts {
  bullish: number;
  neutral: number;
  bearish: number;
  classified: number;
  unclassified: number;
  /** (item, ticker) pairs counted, classified or not. */
  mentions: number;
  items: number;
  posts: number;
  comments: number;
  tickers: number;
}

export interface MarketPulseResponse {
  timeframe: PulseTimeframe;
  status: MarketPulseStatus;
  /** Snapshot older than `staleAfterSeconds` (true also for a stale insufficient one). */
  isStale: boolean;
  score: number | null;
  /** e.g. "Bullish Pulse", "Not enough data", "No pulse yet". Derived, never canned. */
  label: string;
  tone: MarketPulseTone | null;
  /** Built from the stored counts. */
  description: string;
  netSentiment: number | null;
  shares: StanceShares | null;
  counts: MarketPulseCounts | null;
  window: { start: string; end: string } | null;
  /** When the worker computed the snapshot. Null when it never has. */
  snapshotAt: string | null;
  /** posted_at of the newest counted mention. */
  latestMentionAt: string | null;
  staleAfterSeconds: number;
  minClassifiedMentions: number;
  formula: { version: string; expression: string | null };
  source: {
    /** Real social provider(s), e.g. "arctic_shift". Null when none. */
    provider: string | null;
    subreddits: string[];
    /** Mock-provider or provider-less items seen in the window and NOT counted. */
    excludedItems: number;
  };
  warning: string | null;
}

/**
 * How old a snapshot may be before it is called stale: three missed runs and
 * never under fifteen minutes — the same rule as the ticker strip.
 */
export function pulseStaleAfterSeconds(
  refreshSeconds: number = env.MARKET_PULSE_REFRESH_SECONDS,
): number {
  return Math.max(3 * refreshSeconds, 15 * 60);
}

export interface AssembleMarketPulseInput {
  timeframe: PulseTimeframe;
  snapshot: StoredMarketPulse | null;
  now: Date;
  staleAfterSeconds: number;
}

const WARN_NO_SNAPSHOT =
  "No Market Pulse snapshot yet — the worker has not published one from stored Reddit content.";

/**
 * Pure assembly: everything the panel SAYS, with the stored row and the clock
 * passed in. Exported for tests.
 *
 * The stored `score` is served as stored — it is recomputed here only to fill
 * the derived fields (net, shares), never to override what the worker published
 * under its own formula version.
 */
export function assembleMarketPulse(input: AssembleMarketPulseInput): MarketPulseResponse {
  const { timeframe, snapshot, now, staleAfterSeconds } = input;
  const formula = { version: FORMULA_VERSION, expression: FORMULA_EXPRESSION };

  if (!snapshot) {
    return {
      timeframe,
      status: "empty",
      isStale: false,
      score: null,
      label: "No pulse yet",
      tone: null,
      description:
        "The Market Pulse has not been computed from stored Reddit content yet.",
      netSentiment: null,
      shares: null,
      counts: null,
      window: null,
      snapshotAt: null,
      latestMentionAt: null,
      staleAfterSeconds,
      minClassifiedMentions: MIN_CLASSIFIED_MENTIONS,
      formula,
      source: { provider: null, subreddits: [], excludedItems: 0 },
      warning: WARN_NO_SNAPSHOT,
    };
  }

  const s = snapshot;
  const stance: StanceCounts = {
    bullish: s.bullishCount,
    neutral: s.neutralCount,
    bearish: s.bearishCount,
    unclassified: s.unclassifiedCount,
  };
  const classified = s.bullishCount + s.neutralCount + s.bearishCount;
  const shares = stanceShares(stance);
  const ageSeconds = (now.getTime() - Date.parse(s.snapshotAt)) / 1000;
  const isStale = Number.isFinite(ageSeconds) && ageSeconds > staleAfterSeconds;
  const windowPhrase = WINDOW_PHRASE[timeframe];

  const score = s.score;
  const hasScore = score != null && score >= 0 && score <= 100;

  let status: MarketPulseStatus;
  let label: string;
  let tone: MarketPulseTone | null;
  let description: string;
  let netSentiment: number | null = null;

  if (hasScore) {
    status = isStale ? "stale" : "ok";
    label = `${pulseBand(score)} Pulse`;
    tone = pulseTone(score);
    netSentiment = classified > 0
      ? Math.round((100 * (s.bullishCount - s.bearishCount)) / classified)
      : null;
    // shares is non-null whenever a score exists (classified > 0).
    const sh = shares ?? { bullish: 0, neutral: 0, bearish: 0 };
    description =
      `${sh.bullish}% bullish · ${sh.bearish}% bearish · ${sh.neutral}% neutral ` +
      `across ${fmtInt(classified)} ticker ${plural(classified, "mention", "mentions")} ` +
      `on Reddit in ${windowPhrase}.`;
  } else {
    status = "insufficient";
    label = "Not enough data";
    tone = null;
    description =
      classified === 0
        ? `No classified ticker mentions on Reddit in ${windowPhrase} — ` +
          `the pulse needs at least ${s.minClassifiedMentions}.`
        : `Only ${fmtInt(classified)} classified ticker ` +
          `${plural(classified, "mention", "mentions")} on Reddit in ${windowPhrase} — ` +
          `the pulse needs at least ${s.minClassifiedMentions}.`;
  }

  let warning: string | null = null;
  if (isStale) {
    warning = `Market Pulse last computed ${s.snapshotAt}; the worker has not published a newer snapshot.`;
  } else if (s.excludedItemCount > 0) {
    warning =
      `${fmtInt(s.excludedItemCount)} demo or unattributed item(s) in the window ` +
      `were excluded from the count.`;
  }

  return {
    timeframe,
    status,
    isStale,
    score: hasScore ? score : null,
    label,
    tone,
    description,
    netSentiment,
    shares,
    counts: {
      bullish: s.bullishCount,
      neutral: s.neutralCount,
      bearish: s.bearishCount,
      classified,
      unclassified: s.unclassifiedCount,
      mentions: s.mentionCount,
      items: s.itemCount,
      posts: s.postCount,
      comments: s.commentCount,
      tickers: s.tickerCount,
    },
    window: { start: s.windowStart, end: s.windowEnd },
    snapshotAt: s.snapshotAt,
    latestMentionAt: s.latestMentionAt,
    staleAfterSeconds,
    minClassifiedMentions: s.minClassifiedMentions,
    // The expression is only claimed for the version this code implements; a
    // row written under another version keeps its version and no wrong formula.
    formula: {
      version: s.formulaVersion,
      expression: s.formulaVersion === FORMULA_VERSION ? FORMULA_EXPRESSION : null,
    },
    source: {
      provider: s.provider,
      subreddits: s.subreddits,
      excludedItems: s.excludedItemCount,
    },
    warning,
  };
}

export async function getDashboardMarketPulse(params: {
  timeframe: PulseTimeframe;
  now?: Date;
}): Promise<MarketPulseResponse> {
  const snapshot = await readLatestMarketPulse(params.timeframe);
  return assembleMarketPulse({
    timeframe: params.timeframe,
    snapshot,
    now: params.now ?? new Date(),
    staleAfterSeconds: pulseStaleAfterSeconds(),
  });
}
