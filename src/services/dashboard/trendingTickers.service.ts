import {
  tickersRepository,
  type ListingName,
} from "../../repositories/tickers.repository.js";
import type { PulseTimeframe, SocialStance } from "../social/socialData.types.js";
import {
  assembleTickerStrip,
  loadTickerStripInput,
  type TickerStripMeta,
  type TickerStripQuote,
  type TickerStripResponse,
} from "./tickerStrip.service.js";

/**
 * Dashboard Trending Tickers: the ranked table beside Market Pulse.
 *
 * NOT A NEW RANKING. This is the same worker-written Reddit ranking the ticker
 * strip and the Popular Tickers directory read (`trending_ticker_snapshots`,
 * produced by jobs/refreshTickerStrip from stored posts/comments and their
 * sanitized ticker associations), assembled by the strip's own pure function so
 * the two Dashboard views can never disagree about which rows are verified,
 * what a symbol's price is, or whether the ranking is stale. This service only
 * adds what a table needs on top:
 *
 *   rank         competition rank by mention count — tied counts share a rank;
 *   companyName  the symbol's name from the listing directories the catalog job
 *                imports (Nasdaq Trader / Cboe), shaped for display; the
 *                directory's verbatim wording travels alongside as listingName.
 *
 * DATABASE ONLY: three reads (ranking, quotes, names), no provider. A symbol
 * without a directory row gets `companyName: null` — no curated name list
 * stands in for it — and a symbol without a stored quote gets `quote: null`.
 */

export interface TrendingTickerRow {
  /** 1-based. Equal mention counts share a rank (1, 2, 3, 3, 5). */
  rank: number;
  symbol: string;
  /** Display form of the directory name, e.g. "NVIDIA Corporation". Null when unknown. */
  companyName: string | null;
  /** The directory's own wording, e.g. "NVIDIA Corporation - Common Stock". */
  listingName: string | null;
  /** Reddit items mentioning the symbol in the window. Always ≥ 1. */
  mentionCount: number;
  stance: SocialStance | null;
  /** The latest stored real quote, or null when none exists. */
  quote: TickerStripQuote | null;
}

export interface TrendingTickersMeta extends TickerStripMeta {
  names: {
    /** Directories that supplied the served names, e.g. NASDAQ_TRADER_NASDAQ_LISTED. */
    sources: string[];
    named: number;
    /** Served symbols with no directory name. */
    missing: number;
  };
}

export interface TrendingTickersResponse {
  data: TrendingTickerRow[];
  meta: TrendingTickersMeta;
}

/** Words that mark the tail of a listing name as a description of the security. */
const SECURITY_WORDS =
  /\b(?:common|ordinary|capital|preferred|depositary|subordinate|voting|shares?|stock|units?|warrants?|rights|class [a-z0-9]+)\b/i;

/** A trailing security description with no dash before it. */
const TRAILING_DESCRIPTOR =
  /\s+(?:(?:class|series)\s+[a-z0-9]+\s+)?(?:common stock|common shares|ordinary shares|capital stock|subordinate voting shares|common units\b.*|american depositary (?:shares|receipts?)\b.*)\s*$/i;

/**
 * "NVIDIA Corporation - Common Stock" → "NVIDIA Corporation".
 *
 * Listing directories name the SECURITY, not the company; the table has room
 * for the company. Only the security description is removed — nothing is
 * looked up, abbreviated or invented — and a name that would come out empty is
 * returned as published.
 */
export function displayCompanyName(listingName: string): string {
  const published = listingName.trim().replace(/\s+/g, " ");
  let name = published;

  // "Alphabet Inc. - Class A Common Stock": after the dash is the share class.
  const dash = name.match(/^(.*?)\s+-\s+(.*)$/);
  if (dash && SECURITY_WORDS.test(dash[2])) name = dash[1];

  // "BP p.l.c. Common Stock", "Hims & Hers Health, Inc. Class A Common Stock".
  name = name.replace(TRAILING_DESCRIPTOR, "");
  // "Eversource Energy (D/B/A)".
  name = name.replace(/\s*\(d\/b\/a\)\s*$/i, "");
  name = name.replace(/[\s,;-]+$/, "");

  return name.length > 0 ? name : published;
}

/** Competition ranking over rows already ordered by mention count, descending. */
export function competitionRanks(counts: readonly number[]): number[] {
  const ranks: number[] = [];
  counts.forEach((count, i) => {
    ranks.push(i > 0 && count === counts[i - 1] ? ranks[i - 1] : i + 1);
  });
  return ranks;
}

/**
 * Pure assembly — the strip's response plus ranks and names. Exported for tests.
 */
export function assembleTrendingTickers(
  strip: TickerStripResponse,
  names: readonly ListingName[],
): TrendingTickersResponse {
  const bySymbol = new Map(names.map((n) => [n.symbol.toUpperCase(), n]));
  const ranks = competitionRanks(strip.data.map((d) => d.mentionCount));

  const data: TrendingTickerRow[] = strip.data.map((d, i) => {
    const listing = bySymbol.get(d.symbol.toUpperCase()) ?? null;
    return {
      rank: ranks[i],
      symbol: d.symbol,
      companyName: listing ? displayCompanyName(listing.listingName) : null,
      listingName: listing?.listingName ?? null,
      mentionCount: d.mentionCount,
      stance: d.stance,
      quote: d.quote,
    };
  });

  const usedSources = data.flatMap((d) => {
    const listing = bySymbol.get(d.symbol.toUpperCase());
    return listing ? [listing.source] : [];
  });
  const named = data.filter((d) => d.companyName != null).length;

  return {
    data,
    meta: {
      ...strip.meta,
      names: {
        sources: [...new Set(usedSources)].sort(),
        named,
        missing: data.length - named,
      },
    },
  };
}

export async function getDashboardTrendingTickers(params: {
  timeframe: PulseTimeframe;
  limit: number;
  now?: Date;
}): Promise<TrendingTickersResponse> {
  const strip = assembleTickerStrip(await loadTickerStripInput(params));
  const names = await tickersRepository.listingNames(strip.data.map((d) => d.symbol));
  return assembleTrendingTickers(strip, names);
}
