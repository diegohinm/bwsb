import { WORKER_PULSE_TIMEFRAMES } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import {
  readLatestQuotes,
  type StoredQuote,
} from "../repositories/marketSnapshots.repository.js";
import {
  readSocialItems,
  saveTrendingTickers,
  type TrendingTickerInput,
} from "../repositories/socialSnapshots.repository.js";
import { buildSubredditPulse } from "../services/social/pulseAggregator.service.js";
import {
  PULSE_TIMEFRAME_MS,
  type PulseTimeframe,
  type SocialPostItem,
  type SocialStance,
  type TopMentionedTicker,
} from "../services/social/socialData.types.js";

/**
 * WORKER JOB — trending ticker strip.
 *
 * Produces the ranking behind the Dashboard's moving tape, from what Reddit is
 * ACTUALLY talking about:
 *
 *   1. read recent social_posts/social_comments for the timeframe window
 *   2. drop anything from the mock social provider — demo content must never
 *      be counted as a mention
 *   3. rank symbols by mention volume (same aggregator the Pulse page uses),
 *      over each item's `tickers` — the display projection of the sanitized
 *      ticker associations written at ingestion
 *   4. record the latest REAL worker-stored quote alongside, for history
 *   5. store the ranked list in trending_ticker_snapshots
 *
 * Both inputs are DATABASE reads — this job calls no provider, so it works even
 * while upstreams are rate-limited or down; it simply reflects the last
 * ingested data. Symbols are never hardcoded: SPY/QQQ appear only if retail is
 * genuinely mentioning them.
 *
 * The API re-joins quotes at read time (services/dashboard/tickerStrip.service),
 * so the price stored here is a record of what was known when the ranking was
 * made, not what the strip shows.
 */

const MAX_TICKERS_PER_TIMEFRAME = 30;

/** Sentiment label implied by a crowd stance. */
function sentimentOf(stance: SocialStance) {
  return stance === "bullish" ? "positive" : stance === "bearish" ? "negative" : "neutral";
}

/** Content from a real Reddit source. The mock provider's items are excluded. */
export function realSocialItems(items: SocialPostItem[]): SocialPostItem[] {
  return items.filter((it) => it.provider !== "mock");
}

/** Every real provider that contributed content, stable and human-readable. */
function socialProviderLabel(items: SocialPostItem[]): string {
  return [...new Set(items.map((it) => it.provider))].sort().join("+");
}

export interface TrendingRanking {
  /** The real items the ranking was counted over. */
  real: SocialPostItem[];
  top: TopMentionedTicker[];
}

/** Rank symbols by mentions in REAL content only. Pure — exported for tests. */
export function rankTrending(items: SocialPostItem[], timeframe: PulseTimeframe): TrendingRanking {
  const real = realSocialItems(items);
  if (real.length === 0) return { real, top: [] };
  const top = buildSubredditPulse(real, timeframe).topMentioned.slice(0, MAX_TICKERS_PER_TIMEFRAME);
  return { real, top };
}

/**
 * Strip rows for one timeframe. Pure — exported for tests.
 *
 * `isMock` is false by construction: mock content is filtered out before
 * counting and mock quotes are never attached. A symbol without a real quote
 * is NOT demo data — its mentions are real and its price is simply unknown,
 * which is what `price: null` / `providerMarket: "none"` record.
 */
export function buildTrendingRows(
  ranking: TrendingRanking,
  quotes: StoredQuote[],
  timeframe: PulseTimeframe,
): TrendingTickerInput[] {
  const { real, top } = ranking;
  if (real.length === 0 || top.length === 0) return [];

  const realQuotes = new Map(
    quotes
      .filter((q) => !q.isMock && q.provider !== "mock" && q.price != null)
      .map((q) => [q.symbol.toUpperCase(), q]),
  );
  const providerSocial = socialProviderLabel(real);

  return top.map((t) => {
    const q = realQuotes.get(t.symbol.toUpperCase());
    return {
      timeframe,
      symbol: t.symbol,
      mentionCount: t.mentionCount,
      sentiment: sentimentOf(t.stance),
      stance: t.stance,
      price: q?.price ?? null,
      changePct: q?.changePct ?? null,
      providerSocial,
      providerMarket: q ? String(q.provider) : "none",
      isMock: false,
    };
  });
}

export async function refreshTickerStrip(): Promise<JobMetadata> {
  const snapshotAt = new Date().toISOString();
  const perTimeframe: Record<string, number> = {};
  const mockItemsExcluded: Record<string, number> = {};
  let totalRows = 0;

  for (const timeframe of WORKER_PULSE_TIMEFRAMES as readonly PulseTimeframe[]) {
    const sinceIso = new Date(Date.now() - PULSE_TIMEFRAME_MS[timeframe]).toISOString();
    const items = await readSocialItems({ sinceIso, limit: 2_000 });
    const ranking = rankTrending(items, timeframe);
    mockItemsExcluded[timeframe] = items.length - ranking.real.length;
    if (ranking.top.length === 0) {
      perTimeframe[timeframe] = 0;
      continue;
    }

    // Quotes for the ranked symbols only. A symbol without one still ships —
    // mentions are the point, the price is a bonus.
    const quotes = await readLatestQuotes(ranking.top.map((t) => t.symbol));
    const rows = buildTrendingRows(ranking, quotes, timeframe);
    if (rows.length === 0) {
      perTimeframe[timeframe] = 0;
      continue;
    }

    perTimeframe[timeframe] = await saveTrendingTickers(rows, snapshotAt);
    totalRows += rows.length;
  }

  if (totalRows === 0) {
    throw new Error(
      "No real social items in any timeframe window — previous strip snapshots kept.",
    );
  }

  return { snapshotAt, rowsPerTimeframe: perTimeframe, mockItemsExcluded, totalRows };
}

// Manual run: npm run strip:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshTickerStrip", refreshTickerStrip);
}
