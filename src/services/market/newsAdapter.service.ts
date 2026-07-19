/**
 * newsAdapter.service.ts
 *
 * Stub news adapter backed by seeded news_events. Interface is ready for a real
 * provider (NewsAPI, Benzinga, …).
 */
import { marketRepository } from "../../repositories/market.repository.js";

export interface NewsAdapter {
  getNews(ticker: string, limit?: number): Promise<unknown[]>;
  readonly provider: string;
}

export const newsAdapter: NewsAdapter = {
  provider: "stub",
  getNews(ticker: string, limit = 20) {
    return marketRepository.newsForTicker(ticker.toUpperCase(), limit);
  },
};
