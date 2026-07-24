import type { MarketDataProvider } from "../marketData.provider.js";
import type {
  CandleTimeframe,
  MarketCandle,
  MarketDataProviderStatus,
  MarketMover,
  MarketQuote,
  MarketSession,
  OptionChainResponse,
} from "../marketData.types.js";

/**
 * FUTURE PROVIDER — Polygon. Not implemented.
 *
 * getStatus reports `misconfigured` so the service serves demo data; the fetch
 * methods throw so the service falls back to mock. Implement the real client
 * here (backend-only credentials) when the integration lands.
 */
export class PolygonMarketDataProviderStub implements MarketDataProvider {
  readonly name = "polygon" as const;

  async getStatus(): Promise<MarketDataProviderStatus> {
    return {
      provider: "polygon",
      status: "misconfigured",
      displayMode: "mock",
      realtimeEnabled: false,
      optionsRealtimeEnabled: false,
      overnightEnabled: false,
      source: "polygon",
      message: "Polygon provider is not implemented yet — serving demo data.",
      updatedAt: new Date().toISOString(),
    };
  }

  async getQuote(_symbol: string): Promise<MarketQuote> {
    throw new Error("Polygon provider not implemented");
  }
  async getQuotes(_symbols: string[]): Promise<MarketQuote[]> {
    throw new Error("Polygon provider not implemented");
  }
  async getCandles(_params: {
    symbol: string;
    timeframe: CandleTimeframe;
    from: string;
    to: string;
    session?: MarketSession | "all";
  }): Promise<MarketCandle[]> {
    throw new Error("Polygon provider not implemented");
  }
  async getMarketMovers(_params: {
    session: MarketSession | "all";
    limit?: number;
  }): Promise<MarketMover[]> {
    throw new Error("Polygon provider not implemented");
  }
  async getOptionChain(_params: {
    underlying: string;
    expiration?: string;
    type?: "call" | "put" | "all";
    minStrike?: number;
    maxStrike?: number;
  }): Promise<OptionChainResponse> {
    throw new Error("Polygon provider not implemented");
  }
}

export const polygonMarketDataProvider = new PolygonMarketDataProviderStub();
