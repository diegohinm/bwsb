import { TRACKED_SUBREDDITS, displayName } from "./subreddits.js";
import type {
  CommunityDivergenceMetric,
  EmergingTickerMetric,
  PulseHeatmap,
  SentimentSplit,
  SocialPostItem,
  SocialSentiment,
  SocialStance,
  SubredditPulseMetric,
  SubredditPulseResponse,
  PulseTimeframe,
  TopMentionedTicker,
} from "./socialData.types.js";

/**
 * Turn a flat list of normalized social items into the aggregated Subreddit
 * Pulse view. Provider-agnostic: mock, Mindcase and any future provider all
 * produce `SocialPostItem[]` and pipe it through here, so the scoring is
 * identical regardless of source.
 *
 * This is a deterministic MVP baseline — activity/momentum formulas are simple
 * and transparent, ready to be replaced by richer models without changing the
 * response contract.
 */

/** The aggregated analytics — provider/source/timestamps are added by the service. */
export type PulseAggregate = Pick<
  SubredditPulseResponse,
  "overall" | "subreddits" | "emergingTickers" | "divergence" | "heatmap" | "topMentioned"
>;

const VALUE_SUBS = new Set(["ValueInvesting", "SecurityAnalysis", "investing"]);
const OPTIONS_SUBS = new Set(["options"]);
const SQUEEZE_SUBS = new Set(["Shortsqueeze"]);
const SPECULATIVE_SUBS = new Set(["pennystocks"]);

const round1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function isComment(item: SocialPostItem): boolean {
  return item.type === "comment";
}

/** Dominant stance across a set of items, weighted by classifier confidence. */
function dominantStance(items: SocialPostItem[]): {
  stance: SocialStance;
  sentiment: SocialSentiment;
  split: SentimentSplit;
} {
  let bull = 0;
  let bear = 0;
  let neutral = 0;
  for (const it of items) {
    const w = 0.5 + it.confidence;
    if (it.stance === "bullish") bull += w;
    else if (it.stance === "bearish") bear += w;
    else neutral += w;
  }
  const total = bull + bear + neutral || 1;
  const split: SentimentSplit = {
    bullish: Math.round((bull / total) * 100),
    neutral: Math.round((neutral / total) * 100),
    bearish: Math.round((bear / total) * 100),
  };
  let stance: SocialStance = "neutral";
  if (bull > bear && bull >= neutral) stance = "bullish";
  else if (bear > bull && bear >= neutral) stance = "bearish";
  const sentiment: SocialSentiment =
    stance === "bullish"
      ? "positive"
      : stance === "bearish"
        ? "negative"
        : "neutral";
  return { stance, sentiment, split };
}

/**
 * Intra-window momentum: item count in the newer HALF OF THE WINDOW vs the older
 * half, as a percentage. Splits at the temporal midpoint (min+max)/2 — NOT the
 * median, which by construction is always ~50/50 and would report zero.
 */
function windowMomentum(items: SocialPostItem[]): number {
  if (items.length < 4) return 0;
  const times = items
    .map((i) => Date.parse(i.createdAt))
    .filter((t) => !Number.isNaN(t));
  if (times.length < 4) return 0;
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (max === min) return 0;
  const mid = (min + max) / 2;
  const older = times.filter((t) => t < mid).length;
  const newer = times.length - older;
  if (older === 0) return newer > 0 ? 100 : 0;
  return round1(clamp(((newer - older) / older) * 100, -100, 300));
}

function topTickersOf(items: SocialPostItem[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const t of it.tickers) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

function moodFor(
  canonical: string,
  stance: SocialStance,
  activityScore: number,
  topTickers: string[],
): string {
  if (SQUEEZE_SUBS.has(canonical)) return "Squeeze Hunting";
  if (stance === "bearish") return "Cautious";
  if (OPTIONS_SUBS.has(canonical) && stance === "bullish") return "Call Heavy";
  if (SPECULATIVE_SUBS.has(canonical)) return "Speculative";
  if (VALUE_SUBS.has(canonical))
    return stance === "bullish" ? "Constructive" : "Analytical";
  if (stance === "bullish" && activityScore >= 70) return "YOLO Bullish";
  if (stance === "bullish") return "Risk-On";
  if (topTickers.length >= 4) return "Rotational";
  return "Neutral";
}

function explain(
  canonical: string,
  mood: string,
  posts: number,
  comments: number,
): string {
  switch (mood) {
    case "Squeeze Hunting":
      return "High short-interest names back in focus; squeeze setups dominate the feed.";
    case "Call Heavy":
      return "Short-dated call flow is leading the conversation on index and megacap names.";
    case "Speculative":
      return "Fast rotation into low-float momentum names — flow over fundamentals.";
    case "YOLO Bullish":
      return "Call volume and loss-porn both spiking — classic risk-on froth.";
    case "Constructive":
      return "Fundamental DD threads leaning positive on cash-flow names.";
    case "Analytical":
      return "Low-volume, high-quality valuation debate rather than hype.";
    case "Cautious":
      return "Hedges and profit-taking posts gaining share as the mood cools.";
    case "Risk-On":
      return "Broadly bullish chatter across the community.";
    case "Rotational":
      return "Attention spread across many tickers with no single dominant name.";
    default:
      return `${posts} posts and ${comments} comments in the window; no strong directional tilt.`;
  }
}

function buildSubredditMetrics(
  bySub: Map<string, SocialPostItem[]>,
): SubredditPulseMetric[] {
  // Raw activity inputs, so we can normalize the score across communities.
  const raw = TRACKED_SUBREDDITS.map((sub) => {
    const items = bySub.get(sub.name) ?? [];
    const posts = items.filter((i) => !isComment(i));
    const comments = items.filter(isComment);
    const scoreSum = items.reduce((s, i) => s + (i.score ?? 0), 0);
    const commentSum = items.reduce((s, i) => s + (i.numComments ?? 0), 0);
    const diversity = new Set(items.flatMap((i) => i.tickers)).size;
    // Blended activity signal (pre-normalization).
    const activityRaw =
      items.length * 1.0 +
      scoreSum * 0.01 +
      commentSum * 0.02 +
      diversity * 2.0;
    return { sub, items, posts, comments, diversity, activityRaw };
  });

  const maxActivity = Math.max(1, ...raw.map((r) => r.activityRaw));

  return raw
    .map(({ sub, items, posts, comments, activityRaw }) => {
      const { stance, sentiment, split } = dominantStance(items);
      const activityScore = Math.round(clamp((activityRaw / maxActivity) * 100, 0, 100));
      const topTickers = topTickersOf(items, 4);
      const mood = moodFor(sub.name, stance, activityScore, topTickers);
      const recentPosts = [...posts]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 5);
      const recentComments = [...comments]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 5);

      return {
        subreddit: displayName(sub.name),
        activityScore,
        mentions: items.length,
        changePct: windowMomentum(items),
        mood,
        topTickers,
        sentiment,
        stance,
        sentimentSplit: split,
        explanation: explain(sub.name, mood, posts.length, comments.length),
        recentPosts,
        recentComments,
      } satisfies SubredditPulseMetric;
    })
    .sort((a, b) => b.activityScore - a.activityScore);
}

function buildEmerging(
  items: SocialPostItem[],
): EmergingTickerMetric[] {
  // Global midpoint of the window, so "acceleration" = share of a ticker's
  // mentions that landed in the newer half (rising vs. fading).
  const times = items
    .map((i) => Date.parse(i.createdAt))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const midTime = times.length ? times[Math.floor(times.length / 2)] : 0;

  type Acc = {
    subs: Set<string>;
    mentions: number;
    recent: number;
    firstSub: string;
    firstAt: number;
  };
  const byTicker = new Map<string, Acc>();

  for (const it of items) {
    const at = Date.parse(it.createdAt) || 0;
    const isRecent = at >= midTime;
    for (const t of it.tickers) {
      let acc = byTicker.get(t);
      if (!acc) {
        acc = { subs: new Set(), mentions: 0, recent: 0, firstSub: it.subreddit, firstAt: at };
        byTicker.set(t, acc);
      }
      acc.subs.add(it.subreddit);
      acc.mentions += 1;
      if (isRecent) acc.recent += 1;
      if (at < acc.firstAt) {
        acc.firstAt = at;
        acc.firstSub = it.subreddit;
      }
    }
  }

  const maxMentions = Math.max(1, ...[...byTicker.values()].map((a) => a.mentions));

  return [...byTicker.entries()]
    .map(([ticker, acc]) => {
      const spreadCount = acc.subs.size;
      const recentShare = acc.mentions ? acc.recent / acc.mentions : 0;
      const volumeRank = acc.mentions / maxMentions;
      // Weighted: how fast it's rising (recency) + how far it's spread + a small
      // volume contribution. Produces a spread of scores, not a wall of 100s.
      const accelerationScore = clamp(
        Math.round(recentShare * 55 + spreadCount * 8 + volumeRank * 20),
        0,
        100,
      );
      const status: EmergingTickerMetric["status"] =
        spreadCount >= 4 ? "crowded" : spreadCount >= 2 ? "heating" : "early";
      return {
        ticker,
        firstDetectedSubreddit: displayName(acc.firstSub),
        spreadCount,
        accelerationScore,
        status,
      } satisfies EmergingTickerMetric;
    })
    .sort((a, b) => b.accelerationScore - a.accelerationScore)
    .slice(0, 8);
}

function buildDivergence(
  bySub: Map<string, SocialPostItem[]>,
): CommunityDivergenceMetric[] {
  // Per ticker, the stance each community takes.
  const perTicker = new Map<
    string,
    Map<string, SocialPostItem[]>
  >();
  for (const [sub, items] of bySub) {
    for (const it of items) {
      for (const t of it.tickers) {
        if (!perTicker.has(t)) perTicker.set(t, new Map());
        const m = perTicker.get(t)!;
        if (!m.has(sub)) m.set(sub, []);
        m.get(sub)!.push(it);
      }
    }
  }

  const rows: CommunityDivergenceMetric[] = [];
  for (const [ticker, subMap] of perTicker) {
    if (subMap.size < 2) continue;
    const communities = [...subMap.entries()].map(([sub, items]) => {
      const { stance, sentiment } = dominantStance(items);
      return { subreddit: displayName(sub), stance, sentiment };
    });
    const stances = new Set(communities.map((c) => c.stance));
    // Only interesting when communities genuinely disagree.
    if (stances.size < 2) continue;
    const bulls = communities.filter((c) => c.stance === "bullish").map((c) => c.subreddit);
    const bears = communities.filter((c) => c.stance === "bearish").map((c) => c.subreddit);
    const summary =
      bulls.length && bears.length
        ? `Bullish in ${bulls[0]}, bearish in ${bears[0]}.`
        : "Communities disagree on direction.";
    rows.push({ ticker, summary, communities });
  }

  return rows.sort((a, b) => b.communities.length - a.communities.length).slice(0, 6);
}

/**
 * Rank tickers by raw mention volume across every community, tagging each with
 * its dominant crowd stance. This is the "top mentioned across Reddit" list the
 * dashboard ticker strip consumes — deliberately volume-based (not acceleration,
 * unlike `emergingTickers`) so it answers "what is retail talking about most
 * right now". Symbols are already allowlist-filtered upstream by the ticker
 * extractor, so no junk-symbol pass is needed here.
 */
function buildTopMentioned(items: SocialPostItem[], limit: number): TopMentionedTicker[] {
  const byTicker = new Map<string, SocialPostItem[]>();
  for (const it of items) {
    // De-dupe tickers within a single item so one post counts once per symbol.
    for (const t of new Set(it.tickers)) {
      const arr = byTicker.get(t);
      if (arr) arr.push(it);
      else byTicker.set(t, [it]);
    }
  }
  return [...byTicker.entries()]
    .map(([symbol, its]) => ({
      symbol,
      mentionCount: its.length,
      stance: dominantStance(its).stance,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, limit);
}

function buildHeatmap(
  bySub: Map<string, SocialPostItem[]>,
  emerging: EmergingTickerMetric[],
): PulseHeatmap {
  const tickers = emerging.slice(0, 6).map((e) => e.ticker);
  const subs = TRACKED_SUBREDDITS.map((s) => s.name);

  // Raw per-cell mention counts, normalized to 0..100 by the global max.
  const counts: number[][] = tickers.map((ticker) =>
    subs.map((sub) => {
      const items = bySub.get(sub) ?? [];
      return items.filter((i) => i.tickers.includes(ticker)).length;
    }),
  );
  const max = Math.max(1, ...counts.flat());
  const cells = counts.map((row) => row.map((c) => Math.round((c / max) * 100)));

  return {
    tickers,
    subreddits: subs.map((s) => displayName(s)),
    cells,
  };
}

function pulseLabel(score: number): { label: string; description: string } {
  if (score >= 76)
    return {
      label: "YOLO Mania",
      description: "Retail chatter is running hot. Call flow and momentum names dominate the feed.",
    };
  if (score >= 56)
    return {
      label: "Risk-On Retail",
      description: "Retail investing communities are showing elevated bullish activity.",
    };
  if (score >= 31)
    return {
      label: "Cautious Retail",
      description: "Retail attention is split — momentum names hot, broad market cautious.",
    };
  return {
    label: "Risk-Off Retail",
    description: "Retail communities are defensive and de-risking.",
  };
}

/** Build the full aggregate from normalized items. */
export function buildSubredditPulse(
  items: SocialPostItem[],
  _timeframe: PulseTimeframe,
): PulseAggregate {
  const bySub = new Map<string, SocialPostItem[]>();
  for (const it of items) {
    if (!bySub.has(it.subreddit)) bySub.set(it.subreddit, []);
    bySub.get(it.subreddit)!.push(it);
  }

  const subreddits = buildSubredditMetrics(bySub);
  const emergingTickers = buildEmerging(items);
  const divergence = buildDivergence(bySub);
  const heatmap = buildHeatmap(bySub, emergingTickers);
  const topMentioned = buildTopMentioned(items, 25);

  // Weight each community's stance tilt by its activity.
  const totalActivity = subreddits.reduce((s, r) => s + r.activityScore, 0) || 1;
  const bullTilt = subreddits.reduce(
    (s, r) => s + (r.sentimentSplit.bullish - r.sentimentSplit.bearish) * r.activityScore,
    0,
  ) / totalActivity;
  const score = clamp(Math.round(50 + bullTilt * 0.5), 0, 100);
  const { label, description } = pulseLabel(score);
  const changePct = round1(
    subreddits.reduce((s, r) => s + r.changePct, 0) / (subreddits.length || 1),
  );

  return {
    overall: { score, label, description, changePct },
    subreddits,
    emergingTickers,
    divergence,
    heatmap,
    topMentioned,
  };
}
