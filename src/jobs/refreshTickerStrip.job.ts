import { WORKER_PULSE_TIMEFRAMES } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { readLatestQuotes } from "../repositories/marketSnapshots.repository.js";
import {
  readSocialItems,
  saveTrendingTickers,
  type TrendingTickerInput,
} from "../repositories/socialSnapshots.repository.js";
import { buildSubredditPulse } from "../services/social/pulseAggregator.service.js";
import {
  PULSE_TIMEFRAME_MS,
  type PulseTimeframe,
  type SocialStance,
} from "../services/social/socialData.types.js";

/**
 * WORKER JOB — trending ticker strip.
 *
 * Produces the moving tape under the search bar, from what Reddit is ACTUALLY
 * talking about:
 *
 *   1. read recent social_posts/social_comments for the timeframe window
 *   2. rank symbols by mention volume (same aggregator the Pulse page uses)
 *   3. enrich with the latest worker-stored quote (market_quotes_latest)
 *   4. store the ranked list in trending_ticker_snapshots
 *
 * Both inputs are DATABASE reads — this job calls no provider, so it works even
 * while Mindcase/Databento are rate-limited or down; it simply reflects the last
 * ingested data. Symbols are never hardcoded: SPY/QQQ appear only if retail is
 * genuinely mentioning them.
 */

const MAX_TICKERS_PER_TIMEFRAME = 30;

/** Sentiment label implied by a crowd stance. */
function sentimentOf(stance: SocialStance) {
  return stance === "bullish" ? "positive" : stance === "bearish" ? "negative" : "neutral";
}

export async function refreshTickerStrip(): Promise<JobMetadata> {
  const snapshotAt = new Date().toISOString();
  const perTimeframe: Record<string, number> = {};
  let totalRows = 0;

  for (const timeframe of WORKER_PULSE_TIMEFRAMES as readonly PulseTimeframe[]) {
    const sinceIso = new Date(Date.now() - PULSE_TIMEFRAME_MS[timeframe]).toISOString();
    const items = await readSocialItems({ sinceIso, limit: 2_000 });
    if (items.length === 0) {
      perTimeframe[timeframe] = 0;
      continue;
    }

    const { topMentioned } = buildSubredditPulse(items, timeframe);
    const top = topMentioned.slice(0, MAX_TICKERS_PER_TIMEFRAME);
    if (top.length === 0) {
      perTimeframe[timeframe] = 0;
      continue;
    }

    // Enrich with whatever the market job last stored. A symbol without a quote
    // still ships — mentions are the point, the price is a bonus.
    const quotes = await readLatestQuotes(top.map((t) => t.symbol));
    const bySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));
    const socialProvider = items[0]?.provider ?? "mock";

    const rows: TrendingTickerInput[] = top.map((t) => {
      const q = bySymbol.get(t.symbol.toUpperCase());
      return {
        timeframe,
        symbol: t.symbol,
        mentionCount: t.mentionCount,
        sentiment: sentimentOf(t.stance),
        stance: t.stance,
        price: q?.price ?? null,
        changePct: q?.changePct ?? null,
        providerSocial: socialProvider,
        providerMarket: q?.provider ?? "none",
        // Demo if the social side is demo, or if the quote is demo/absent.
        isMock: socialProvider === "mock" || !q || q.isMock,
      };
    });

    perTimeframe[timeframe] = await saveTrendingTickers(rows, snapshotAt);
    totalRows += rows.length;
  }

  if (totalRows === 0) {
    throw new Error(
      "No social items in any timeframe window — run refreshSocialPulse first; previous strip snapshots kept.",
    );
  }

  return { snapshotAt, rowsPerTimeframe: perTimeframe, totalRows };
}

// Manual run: npm run strip:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshTickerStrip", refreshTickerStrip);
}
