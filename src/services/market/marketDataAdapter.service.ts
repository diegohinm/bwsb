/**
 * marketDataAdapter.service.ts
 *
 * Stub market-data adapter. Returns the latest seeded market_snapshots. The
 * interface is provider-agnostic so a real Polygon / Finnhub / Alpha Vantage
 * client can be dropped in later without touching callers.
 */
import { marketRepository } from "../../repositories/market.repository.js";
import type { MarketSnapshot } from "../../types/domain.js";

export interface MarketDataAdapter {
  getQuote(ticker: string): Promise<MarketSnapshot | null>;
  getQuotes(): Promise<MarketSnapshot[]>;
  readonly provider: string;
}

export const marketDataAdapter: MarketDataAdapter = {
  provider: "stub",
  getQuote(ticker: string) {
    return marketRepository.latestSnapshot(ticker.toUpperCase());
  },
  getQuotes() {
    return marketRepository.latestSnapshots();
  },
};
