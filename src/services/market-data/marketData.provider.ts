import type {
  CandleTimeframe,
  DelayedBarsResult,
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

  /**
   * DELAYED INGESTION (optional) — newest historical bar at or before a cutoff,
   * per symbol. Implemented by providers that can serve delayed data from a
   * historical/REST endpoint without a real-time entitlement. The ingestion
   * worker prefers this over `getQuotes` whenever the display mode is delayed:
   * no live stream is opened and nothing fresher than the cutoff is requested.
   */
  getDelayedBars?(params: {
    symbols: string[];
    cutoffIso: string;
    lookbackMinutes?: number;
    wideLookbackDays?: number;
  }): Promise<DelayedBarsResult>;

  /** Previous daily close per symbol, for change / changePct. Best-effort. */
  getPreviousDailyCloses?(
    symbols: string[],
    beforeIso: string,
  ): Promise<Map<string, number>>;
}
