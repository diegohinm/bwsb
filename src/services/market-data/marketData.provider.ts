import type {
  CandleTimeframe,
  MarketCandle,
  MarketDataProviderName,
  MarketDataProviderStatus,
  MarketMover,
  MarketQuote,
  MarketSession,
  OptionChainResponse,
} from "./marketData.types.js";

// NOTE: market data is fully separate from the social/pulse provider — this
// module never imports from services/social.

/**
 * Contract every market data source implements. Callers depend only on this
 * interface (via the factory + service), never on a concrete provider, so the
 * upstream can be swapped by changing one env var.
 */
export interface MarketDataProvider {
  readonly name: MarketDataProviderName;

  /** Health/config of this provider. Never returns secrets. */
  getStatus(): Promise<MarketDataProviderStatus>;

  getQuote(symbol: string): Promise<MarketQuote>;

  getQuotes(symbols: string[]): Promise<MarketQuote[]>;

  getCandles(params: {
    symbol: string;
    timeframe: CandleTimeframe;
    from: string;
    to: string;
    session?: MarketSession | "all";
  }): Promise<MarketCandle[]>;

  getMarketMovers(params: {
    session: MarketSession | "all";
    limit?: number;
  }): Promise<MarketMover[]>;

  getOptionChain(params: {
    underlying: string;
    expiration?: string;
    type?: "call" | "put" | "all";
    minStrike?: number;
    maxStrike?: number;
  }): Promise<OptionChainResponse>;
}
