import type { MarketDataProvider } from "../marketData.provider.js";
import {
  currentSession,
  clamp,
  rand,
  randInt,
  round2,
} from "../marketData.util.js";
import type {
  AssetType,
  CandleTimeframe,
  MarketCandle,
  MarketDataProviderStatus,
  MarketMover,
  MarketQuote,
  MarketSession,
  OptionChainResponse,
  OptionContract,
} from "../marketData.types.js";

/**
 * DEMO provider. Deterministic, no network — always available, so it doubles as
 * the universal fallback whenever a real provider is missing credentials, is
 * license-gated, or fails.
 *
 * Everything is flagged provider="mock", source="mock", displayMode="mock",
 * isMock=true, isDelayed=false so the UI can never present it as real.
 */

/** Reference universe with plausible base prices + names. */
const UNIVERSE: Record<string, { name: string; base: number; type: AssetType }> = {
  RDDT: { name: "Reddit Inc.", base: 172, type: "equity" },
  POET: { name: "POET Technologies", base: 6.4, type: "equity" },
  GME: { name: "GameStop Corp.", base: 24, type: "equity" },
  AMC: { name: "AMC Entertainment", base: 4.2, type: "equity" },
  NVDA: { name: "NVIDIA Corp.", base: 128, type: "equity" },
  TSLA: { name: "Tesla Inc.", base: 248, type: "equity" },
  PLTR: { name: "Palantir Technologies", base: 41, type: "equity" },
  HOOD: { name: "Robinhood Markets", base: 23, type: "equity" },
  SOFI: { name: "SoFi Technologies", base: 9.1, type: "equity" },
  MSFT: { name: "Microsoft Corp.", base: 428, type: "equity" },
  AAPL: { name: "Apple Inc.", base: 227, type: "equity" },
  META: { name: "Meta Platforms", base: 565, type: "equity" },
  AMZN: { name: "Amazon.com Inc.", base: 186, type: "equity" },
  NFLX: { name: "Netflix Inc.", base: 715, type: "equity" },
  AMD: { name: "Advanced Micro Devices", base: 158, type: "equity" },
  INTC: { name: "Intel Corp.", base: 23, type: "equity" },
  MU: { name: "Micron Technology", base: 104, type: "equity" },
  COIN: { name: "Coinbase Global", base: 215, type: "equity" },
  SPY: { name: "SPDR S&P 500 ETF", base: 566, type: "etf" },
  QQQ: { name: "Invesco QQQ Trust", base: 484, type: "etf" },
};

const OPTIONABLE = ["RDDT", "NVDA", "TSLA", "GME", "SPY", "QQQ"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic base info for any symbol (unknowns get a synthesized base). */
function symbolInfo(symbol: string): { name: string; base: number; type: AssetType } {
  const known = UNIVERSE[symbol];
  if (known) return known;
  const base = round2(5 + rand(`base:${symbol}`) * 300);
  return { name: `${symbol} (mock)`, base, type: "equity" };
}

/** A stable-per-symbol change% in roughly [-7, +7]. */
function changePctFor(symbol: string, session: MarketSession): number {
  const s = rand(`chg:${symbol}:${session}`) * 14 - 7;
  return round2(s);
}

function buildQuote(symbol: string, session: MarketSession): MarketQuote {
  const info = symbolInfo(symbol);
  const changePct = changePctFor(symbol, session);
  const previousClose = round2(info.base);
  const price = round2(previousClose * (1 + changePct / 100));
  const change = round2(price - previousClose);
  const spread = clamp(round2(price * 0.0008), 0.01, 2);
  const dayRange = Math.abs(change) + round2(price * 0.01);

  return {
    symbol,
    assetType: info.type,
    provider: "mock",
    source: "mock",
    displayMode: "mock",
    session,
    price,
    bid: round2(price - spread),
    ask: round2(price + spread),
    bidSize: randInt(`bs:${symbol}`, 1, 40) * 100,
    askSize: randInt(`as:${symbol}`, 1, 40) * 100,
    open: round2(previousClose * (1 + (rand(`open:${symbol}`) * 0.02 - 0.01))),
    high: round2(price + dayRange * rand(`hi:${symbol}`)),
    low: round2(price - dayRange * rand(`lo:${symbol}`)),
    previousClose,
    change,
    changePct,
    volume: randInt(`vol:${symbol}:${session}`, 200_000, 60_000_000),
    timestamp: new Date().toISOString(),
    isMock: true,
    isDelayed: false,
  };
}

export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = "mock" as const;

  async getStatus(): Promise<MarketDataProviderStatus> {
    return {
      provider: "mock",
      status: "mock",
      displayMode: "mock",
      realtimeEnabled: false,
      optionsRealtimeEnabled: false,
      overnightEnabled: false,
      source: "mock",
      message: "Serving deterministic demo market data. No provider network calls.",
      updatedAt: new Date().toISOString(),
    };
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    return buildQuote(symbol.toUpperCase(), currentSession());
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    const session = currentSession();
    return symbols.map((s) => buildQuote(s.toUpperCase(), session));
  }

  async getCandles(params: {
    symbol: string;
    timeframe: CandleTimeframe;
    from: string;
    to: string;
    session?: MarketSession | "all";
  }): Promise<MarketCandle[]> {
    const symbol = params.symbol.toUpperCase();
    const info = symbolInfo(symbol);
    const stepMs = timeframeMs(params.timeframe);
    const from = Date.parse(params.from) || Date.now() - 30 * DAY_MS;
    const to = Date.parse(params.to) || Date.now();
    const count = clamp(Math.floor((to - from) / stepMs), 2, 500);

    const candles: MarketCandle[] = [];
    let close = info.base;
    for (let i = 0; i < count; i += 1) {
      const t = from + i * stepMs;
      const drift = (rand(`c:${symbol}:${params.timeframe}:${i}`) - 0.5) * info.base * 0.02;
      const open = round2(close);
      close = round2(clamp(open + drift, info.base * 0.5, info.base * 1.8));
      const high = round2(Math.max(open, close) * (1 + rand(`h:${symbol}:${i}`) * 0.01));
      const low = round2(Math.min(open, close) * (1 - rand(`l:${symbol}:${i}`) * 0.01));
      candles.push({
        symbol,
        provider: "mock",
        source: "mock",
        displayMode: "mock",
        open,
        high,
        low,
        close,
        volume: randInt(`cv:${symbol}:${i}`, 100_000, 20_000_000),
        timestamp: new Date(t).toISOString(),
        isMock: true,
        isDelayed: false,
      });
    }
    return candles;
  }

  async getMarketMovers(params: {
    session: MarketSession | "all";
    limit?: number;
  }): Promise<MarketMover[]> {
    const session: MarketSession =
      params.session === "all" ? currentSession() : params.session;
    const limit = params.limit ?? 10;
    const reason = MOVER_REASON[session];

    return Object.keys(UNIVERSE)
      .map((symbol) => {
        const q = buildQuote(symbol, session);
        return {
          symbol,
          name: UNIVERSE[symbol].name,
          price: q.price,
          changePct: q.changePct ?? 0,
          volume: q.volume,
          session,
          reason,
          timestamp: q.timestamp,
        } satisfies MarketMover;
      })
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
      .slice(0, limit);
  }

  async getOptionChain(params: {
    underlying: string;
    expiration?: string;
    type?: "call" | "put" | "all";
    minStrike?: number;
    maxStrike?: number;
  }): Promise<OptionChainResponse> {
    const underlying = params.underlying.toUpperCase();
    const info = symbolInfo(underlying);
    const spot = buildQuote(underlying, currentSession()).price ?? info.base;
    const expirations = nextExpirations(underlying, 4);
    const wantType = params.type ?? "all";

    const contracts: OptionContract[] = [];
    for (const expiration of expirations) {
      const strikes = strikeLadder(spot, underlying, expiration);
      for (const strike of strikes) {
        if (params.minStrike != null && strike < params.minStrike) continue;
        if (params.maxStrike != null && strike > params.maxStrike) continue;
        for (const type of ["call", "put"] as const) {
          if (wantType !== "all" && wantType !== type) continue;
          contracts.push(buildContract(underlying, expiration, strike, type, spot));
        }
      }
    }

    return {
      underlying,
      provider: "mock",
      source: "mock",
      displayMode: "mock",
      expirationDates: expirations,
      contracts,
      isMock: true,
      isDelayed: false,
      updatedAt: new Date().toISOString(),
    };
  }
}

// ── Options helpers ──────────────────────────────────────────────────────────

function nextExpirations(symbol: string, n: number): string[] {
  // Weekly Fridays starting from the upcoming one (deterministic base date so
  // output is stable). Uses "now" only to advance to the next Friday.
  const out: string[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  // advance to next Friday
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  for (let i = 0; i < n; i += 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

function strikeLadder(spot: number, symbol: string, expiration: string): number[] {
  const step = spot >= 200 ? 5 : spot >= 50 ? 2.5 : spot >= 10 ? 1 : 0.5;
  const atm = Math.round(spot / step) * step;
  const strikes: number[] = [];
  for (let i = -4; i <= 4; i += 1) {
    const k = round2(atm + i * step);
    if (k > 0) strikes.push(k);
  }
  void symbol;
  void expiration;
  return strikes;
}

function buildContract(
  underlying: string,
  expiration: string,
  strike: number,
  type: "call" | "put",
  spot: number,
): OptionContract {
  const seed = `${underlying}:${expiration}:${strike}:${type}`;
  const intrinsic =
    type === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const extrinsic = round2(spot * 0.02 * rand(`ext:${seed}`) + 0.05);
  const mark = round2(intrinsic + extrinsic);
  const spread = clamp(round2(mark * 0.06), 0.01, 0.5);
  const dte = Math.max(
    1,
    Math.round((Date.parse(expiration) - Date.now()) / DAY_MS),
  );
  const iv = round2(0.3 + rand(`iv:${seed}`) * 0.9);
  const moneyness = Math.abs(spot - strike) / spot;
  const delta = round2(
    (type === "call" ? 1 : -1) * clamp(0.5 - moneyness * (type === "call" ? 1 : -1), 0.02, 0.98),
  );

  const expiryCompact = expiration.replace(/-/g, "").slice(2); // YYMMDD
  const optionSymbol = `${underlying}${expiryCompact}${type === "call" ? "C" : "P"}${Math.round(
    strike * 1000,
  )
    .toString()
    .padStart(8, "0")}`;

  return {
    underlying,
    optionSymbol,
    expiration,
    strike,
    type,
    provider: "mock",
    source: "mock",
    displayMode: "mock",
    bid: round2(mark - spread),
    ask: round2(mark + spread),
    last: mark,
    mark,
    volume: randInt(`ov:${seed}`, 0, dte <= 1 ? 40_000 : 8_000),
    openInterest: randInt(`oi:${seed}`, 0, 60_000),
    impliedVolatility: iv,
    delta,
    gamma: round2(rand(`g:${seed}`) * 0.08),
    theta: round2(-rand(`t:${seed}`) * 0.3),
    vega: round2(rand(`v:${seed}`) * 0.2),
    timestamp: new Date().toISOString(),
    isMock: true,
    isDelayed: false,
  };
}

const MOVER_REASON: Record<MarketSession, string> = {
  premarket: "Premarket gap on volume",
  regular: "Intraday momentum",
  after_hours: "After-hours move on headlines",
  overnight: "Overnight session move",
  closed: "Last session close",
};

function timeframeMs(tf: CandleTimeframe): number {
  switch (tf) {
    case "1m":
      return 60 * 1000;
    case "5m":
      return 5 * 60 * 1000;
    case "15m":
      return 15 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "1d":
    default:
      return DAY_MS;
  }
}

/** Symbols with a mock option chain (used for empty-state decisions). */
export const MOCK_OPTIONABLE = OPTIONABLE;

export const mockMarketDataProvider = new MockMarketDataProvider();
