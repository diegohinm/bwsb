/**
 * shortInterestAdapter.service.ts
 *
 * Stub short-interest / squeeze-risk adapter backed by seeded
 * short_interest_snapshots. Interface is ready for a real data provider.
 */
import { marketRepository } from "../../repositories/market.repository.js";

export interface ShortInterestAdapter {
  getShortInterest(ticker: string): Promise<unknown | null>;
  getAll(): Promise<unknown[]>;
  readonly provider: string;
}

export const shortInterestAdapter: ShortInterestAdapter = {
  provider: "stub",
  getShortInterest(ticker: string) {
    return marketRepository.shortInterest(ticker.toUpperCase());
  },
  getAll() {
    return marketRepository.shortInterestLatest();
  },
};
