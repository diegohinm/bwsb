import { env } from "../../config/env.js";
import { mockMarketDataProvider } from "./providers/mockMarketData.provider.js";
import { databentoMarketDataProvider } from "./providers/databentoMarketData.provider.js";
import { polygonMarketDataProvider } from "./providers/polygonMarketData.provider.js";
import { alpacaMarketDataProvider } from "./providers/alpacaMarketData.provider.js";
import { twelvedataMarketDataProvider } from "./providers/twelveDataMarketData.provider.js";
import type { MarketDataProvider } from "./marketData.provider.js";

/**
 * Resolve the configured market data provider from MARKET_DATA_PROVIDER.
 * Anything unrecognized falls back to the mock provider so the app always has a
 * working data source.
 */
export function getMarketDataProvider(): MarketDataProvider {
  switch (env.MARKET_DATA_PROVIDER) {
    case "databento":
      return databentoMarketDataProvider;
    case "polygon":
      return polygonMarketDataProvider;
    case "alpaca":
      return alpacaMarketDataProvider;
    case "twelvedata":
      return twelvedataMarketDataProvider;
    case "mock":
    default:
      return mockMarketDataProvider;
  }
}

export { mockMarketDataProvider };
