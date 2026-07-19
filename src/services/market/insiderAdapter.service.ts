/**
 * insiderAdapter.service.ts
 *
 * Stub insider-activity adapter backed by seeded insider_activity_events.
 * Interface is ready for a real SEC / Finnhub insider feed.
 */
import { marketRepository } from "../../repositories/market.repository.js";

export interface InsiderAdapter {
  getInsiderActivity(ticker: string, limit?: number): Promise<unknown[]>;
  readonly provider: string;
}

export const insiderAdapter: InsiderAdapter = {
  provider: "stub",
  getInsiderActivity(ticker: string, limit = 20) {
    return marketRepository.insiderForTicker(ticker.toUpperCase(), limit);
  },
};
