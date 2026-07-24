import { getSubredditPulse } from "../social/index.js";
import { getQuotes } from "../market-data/marketData.service.js";
import type { PulseTimeframe, SocialStance } from "../social/socialData.types.js";
import type { MarketQuote } from "../market-data/marketData.types.js";

/**
 * Dashboard ticker strip: the moving tape under the search bar.
 *
 * This is the single place that JOINS social + market data so the frontend
 * consumes one flat, consolidated list and never stitches the two subsystems
 * together itself. Both dependencies are the LEGAL/SAFETY chokepoint services
 * (never a provider directly), so caching, mock fallback and display-mode
 * labeling already apply:
 *
 *   1. social  → top tickers by Reddit mention volume (getSubredditPulse)
 *   2. market  → enrich those symbols with quotes (getQuotes)
 *
 * Every layer degrades gracefully: if social falls back to demo, `isMock` is
 * flagged; if market is unavailable the strip still shows symbol + mentionCount
 * with a null price rather than breaking.
 */

export interface TickerStripItem {
  symbol: string;
  mentionCount: number;
  sentiment: SocialStance;
  price: number | null;
  changePct: number | null;
  source: {
    social: string;
    market: string;
  };
  /** True when EITHER the social or the market side of this row is demo data. */
  isMock: boolean;
  updatedAt: string;
}

export interface TickerStripMeta {
  timeframe: PulseTimeframe;
  limit: number;
  providerSocial: string;
  providerMarket: string;
  isMock: boolean;
  warning: string | null;
}

export interface TickerStripResponse {
  data: TickerStripItem[];
  meta: TickerStripMeta;
}

export async function getDashboardTickerStrip(params: {
  timeframe: PulseTimeframe;
  limit: number;
}): Promise<TickerStripResponse> {
  const { timeframe, limit } = params;

  // 1. Social: top mentioned across every tracked community (cached + mock-safe).
  const pulse = await getSubredditPulse({ timeframe });
  const top = pulse.topMentioned.slice(0, limit);
  const symbols = top.map((t) => t.symbol);

  // 2. Market: enrich with quotes. A total market failure is non-fatal — we keep
  //    the symbols and mention counts and simply omit prices.
  let quotes: MarketQuote[] = [];
  let providerMarket = "mock";
  let marketMock = false;
  let marketWarning: string | null = null;
  if (symbols.length > 0) {
    try {
      quotes = await getQuotes(symbols);
      if (quotes.length > 0) {
        providerMarket = quotes[0].provider;
        marketMock = quotes.some((q) => q.isMock);
        marketWarning = quotes.find((q) => q.warning)?.warning ?? null;
      }
    } catch {
      // getQuotes already falls back to mock internally, so reaching here means
      // the whole market subsystem is down. Show mentions only.
      quotes = [];
      marketMock = true;
      marketWarning = "Market data unavailable. Showing Reddit mentions only.";
    }
  }
  const bySym = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));

  const nowIso = new Date().toISOString();
  const data: TickerStripItem[] = top.map((t) => {
    const q = bySym.get(t.symbol.toUpperCase());
    // A row is demo if the social feed is demo OR its quote is demo/absent.
    const rowMock = pulse.isMock || !q || q.isMock;
    return {
      symbol: t.symbol,
      mentionCount: t.mentionCount,
      sentiment: t.stance,
      price: q?.price ?? null,
      changePct: q?.changePct ?? null,
      source: {
        social: pulse.provider,
        market: q?.provider ?? providerMarket,
      },
      isMock: rowMock,
      updatedAt: q?.timestamp ?? pulse.updatedAt ?? nowIso,
    };
  });

  return {
    data,
    meta: {
      timeframe,
      limit,
      providerSocial: pulse.provider,
      providerMarket,
      isMock: pulse.isMock || marketMock,
      warning: pulse.warning ?? marketWarning ?? null,
    },
  };
}
