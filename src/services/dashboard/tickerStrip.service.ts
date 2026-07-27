import { readLatestTrendingTickers } from "../../repositories/socialSnapshots.repository.js";
import type { PulseTimeframe, SocialStance } from "../social/socialData.types.js";

/**
 * Dashboard ticker strip: the moving tape under the search bar.
 *
 * DATABASE ONLY. The ingestion worker (jobs/refreshTickerStrip.job.ts) already
 * did the join — top mentioned tickers from Reddit enriched with the latest
 * stored quote — and wrote it to `trending_ticker_snapshots`. This service just
 * serves the newest snapshot, so a page load costs one indexed query and calls
 * no provider.
 *
 * The list is whatever retail is actually talking about: no symbol is forced in.
 * SPY/QQQ appear only when they are genuinely among the most-mentioned.
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
  /** When the worker produced this snapshot (null when it never has). */
  snapshotAt: string | null;
}

export interface TickerStripResponse {
  data: TickerStripItem[];
  meta: TickerStripMeta;
}

const WARN_NO_SNAPSHOT =
  "No ingested ticker data yet — the ingestion worker has not published a snapshot.";

export async function getDashboardTickerStrip(params: {
  timeframe: PulseTimeframe;
  limit: number;
}): Promise<TickerStripResponse> {
  const { timeframe, limit } = params;
  const rows = await readLatestTrendingTickers(timeframe, limit);

  if (rows.length === 0) {
    return {
      data: [],
      meta: {
        timeframe,
        limit,
        providerSocial: "none",
        providerMarket: "none",
        isMock: false,
        warning: WARN_NO_SNAPSHOT,
        snapshotAt: null,
      },
    };
  }

  const data: TickerStripItem[] = rows.map((r) => ({
    symbol: r.symbol,
    mentionCount: r.mentionCount,
    sentiment: r.stance,
    price: r.price,
    changePct: r.changePct,
    source: { social: r.providerSocial, market: r.providerMarket },
    isMock: r.isMock,
    updatedAt: r.snapshotAt,
  }));

  const anyMock = rows.some((r) => r.isMock);
  const missingQuotes = rows.filter((r) => r.price === null).length;

  return {
    data,
    meta: {
      timeframe,
      limit,
      providerSocial: rows[0].providerSocial,
      providerMarket: rows[0].providerMarket,
      isMock: anyMock,
      warning: anyMock
        ? "Some rows are demo data."
        : missingQuotes > 0
          ? `${missingQuotes} symbol(s) have no published quote yet — showing mentions only.`
          : null,
      snapshotAt: rows[0].snapshotAt,
    },
  };
}
