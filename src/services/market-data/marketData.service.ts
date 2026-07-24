import { env } from "../../config/env.js";
import { memoryCache } from "../cache/memoryCache.js";
import { getMarketDataProvider, mockMarketDataProvider } from "./marketDataProvider.factory.js";
import { currentSession } from "./marketData.util.js";
import type {
  CandleTimeframe,
  MarketCandle,
  MarketDataDisplayMode,
  MarketDataProviderStatus,
  MarketMover,
  MarketQuote,
  MarketSession,
  OptionChainResponse,
} from "./marketData.types.js";

/**
 * Market data access point + LEGAL-SAFETY chokepoint. Routes call THIS module,
 * never a provider directly, so that caching, mock fallback, and — critically —
 * license gating / display-mode labeling are applied uniformly for every
 * provider. No caller can accidentally present mock as real or unlicensed
 * real-time data as public.
 */

const TTL = env.MARKET_DATA_CACHE_TTL_SECONDS;
// Options are cached longer than equities. Internal default — no env var.
const OPTIONS_TTL = 60;

// ── Safety flags (internal defaults — see providers/databento.config.ts) ─────
// Public real-time / options-real-time display stay OFF: data is presented as
// delayed / EOD / demo and NEVER labeled real-time without a deliberate code
// change. `MARKET_DATA_MODE=realtime` alone does not lift this — the internal
// PUBLIC_REALTIME gate must also be true.
const PUBLIC_REALTIME = false;
const PUBLIC_OPTIONS_REALTIME = false;
export const realtimeEnabled = PUBLIC_REALTIME && env.MARKET_DATA_MODE === "realtime";
export const optionsRealtimeEnabled = PUBLIC_OPTIONS_REALTIME;
// Overnight support is provided by the Databento overnight dataset. It is
// "enabled" (attempted from the real provider) whenever Databento is configured;
// if the overnight feed is unavailable the service serves demo data + a warning.
export const overnightEnabled = env.MARKET_DATA_PROVIDER === "databento";

const WARN_DELAYED = "Market data is delayed (safe mode), not real-time.";
const WARN_OPTIONS = "Options data is delayed/EOD, not real-time.";
const WARN_FALLBACK = "Databento market data unavailable. Showing demo data.";
const WARN_MISCONFIGURED =
  "Databento is not configured (missing API key). Showing demo data.";
const WARN_OVERNIGHT_FALLBACK = "Databento overnight data unavailable. Showing demo data.";

/** Effective equities display mode. `realtime` downgrades to `delayed` in safe mode. */
function equityDisplayMode(): MarketDataDisplayMode {
  if (env.MARKET_DATA_MODE === "realtime" && !realtimeEnabled) return "delayed";
  return env.MARKET_DATA_MODE;
}
/** Effective options display mode (EOD unless options real-time is enabled). */
function optionsDisplayMode(): MarketDataDisplayMode {
  return optionsRealtimeEnabled ? "realtime" : "end_of_day";
}

// ── Diagnostics (admin/status) ───────────────────────────────────────────────
type Diagnostics = {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  usingMockFallback: boolean;
};
const diagnostics: Diagnostics = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  usingMockFallback: false,
};

function recordError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  diagnostics.lastErrorAt = new Date().toISOString();
  diagnostics.lastError = msg;
  return msg;
}
function recordSuccess(usingMock: boolean): void {
  diagnostics.lastSuccessAt = new Date().toISOString();
  diagnostics.usingMockFallback = usingMock;
}

function isMockProvider(): boolean {
  return env.MARKET_DATA_PROVIDER === "mock";
}

// ── Status ───────────────────────────────────────────────────────────────────

/** Provider status with EFFECTIVE (license-aware) capability flags. */
export async function getMarketProviderStatus(): Promise<MarketDataProviderStatus> {
  const provider = getMarketDataProvider();
  let base: MarketDataProviderStatus;
  try {
    base = await provider.getStatus();
  } catch (err) {
    base = {
      provider: provider.name,
      status: "error",
      displayMode: "mock",
      realtimeEnabled: false,
      optionsRealtimeEnabled: false,
      overnightEnabled: false,
      source: provider.name,
      message: recordError(err),
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...base,
    // Effective, license-aware flags override whatever the provider reported.
    displayMode: isMockProvider()
      ? "mock"
      : base.status === "ready"
        ? equityDisplayMode()
        : "mock",
    realtimeEnabled,
    optionsRealtimeEnabled,
    overnightEnabled,
  };
}

/** Full diagnostics blob for /api/market-data/status and admin. No secrets. */
export async function getMarketDataDiagnostics() {
  const status = await getMarketProviderStatus();
  return {
    ...status,
    configuredProvider: env.MARKET_DATA_PROVIDER,
    mode: env.MARKET_DATA_MODE,
    cacheTtlSeconds: TTL,
    optionsCacheTtlSeconds: OPTIONS_TTL,
    overnightSupported: overnightEnabled,
    lastSuccessAt: diagnostics.lastSuccessAt,
    lastErrorAt: diagnostics.lastErrorAt,
    lastError: diagnostics.lastError,
    usingMockFallback: diagnostics.usingMockFallback,
  };
}

// ── Quotes ───────────────────────────────────────────────────────────────────

/** Apply display-mode labeling + safe-mode warnings to a real-provider quote. */
function labelQuote(q: MarketQuote): MarketQuote {
  const mode = equityDisplayMode();
  return {
    ...q,
    displayMode: mode,
    isDelayed: mode !== "realtime",
    ...(mode === "delayed" ? { warning: WARN_DELAYED } : {}),
  };
}

export async function getQuote(symbol: string): Promise<MarketQuote> {
  const sym = symbol.toUpperCase();
  const mode = isMockProvider() ? "mock" : equityDisplayMode();
  const key = `quote:${env.MARKET_DATA_PROVIDER}:${sym}:${mode}`;
  const cached = memoryCache.get<MarketQuote>(key);
  if (cached) return cached;

  let result: MarketQuote;
  if (isMockProvider()) {
    result = await mockMarketDataProvider.getQuote(sym);
    recordSuccess(true);
  } else {
    try {
      const raw = await getMarketDataProvider().getQuote(sym);
      result = labelQuote(raw);
      recordSuccess(result.isMock);
    } catch (err) {
      const msg = recordError(err);
      result = await mockMarketDataProvider.getQuote(sym);
      result.warning = /not configured/i.test(msg) ? WARN_MISCONFIGURED : WARN_FALLBACK;
      recordSuccess(true);
    }
  }
  memoryCache.set(key, result, TTL);
  return result;
}

export async function getQuotes(symbols: string[]): Promise<MarketQuote[]> {
  const syms = symbols.map((s) => s.toUpperCase());
  const mode = isMockProvider() ? "mock" : equityDisplayMode();
  const key = `quotes:${env.MARKET_DATA_PROVIDER}:${syms.join(",")}:${mode}`;
  const cached = memoryCache.get<MarketQuote[]>(key);
  if (cached) return cached;

  let result: MarketQuote[];
  if (isMockProvider()) {
    result = await mockMarketDataProvider.getQuotes(syms);
    recordSuccess(true);
  } else {
    try {
      const raw = await getMarketDataProvider().getQuotes(syms);
      const bySym = new Map(raw.map((q) => [q.symbol.toUpperCase(), labelQuote(q)]));
      // Backfill any symbol the provider didn't return with mock data.
      const missing = syms.filter((s) => !bySym.has(s));
      if (missing.length) {
        const mocks = await mockMarketDataProvider.getQuotes(missing);
        for (const m of mocks) bySym.set(m.symbol.toUpperCase(), { ...m, warning: WARN_FALLBACK });
      }
      result = syms.map((s) => bySym.get(s)!).filter(Boolean);
      recordSuccess(result.some((q) => q.isMock));
    } catch (err) {
      const msg = recordError(err);
      result = await mockMarketDataProvider.getQuotes(syms);
      const w = /not configured/i.test(msg) ? WARN_MISCONFIGURED : WARN_FALLBACK;
      result = result.map((q) => ({ ...q, warning: w }));
      recordSuccess(true);
    }
  }
  memoryCache.set(key, result, TTL);
  return result;
}

// ── Candles ──────────────────────────────────────────────────────────────────

export async function getCandles(params: {
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
  session?: MarketSession | "all";
}): Promise<MarketCandle[]> {
  const sym = params.symbol.toUpperCase();
  const session = params.session ?? "all";
  const key = `candles:${env.MARKET_DATA_PROVIDER}:${sym}:${params.timeframe}:${params.from}:${params.to}:${session}`;
  const cached = memoryCache.get<MarketCandle[]>(key);
  if (cached) return cached;

  let result: MarketCandle[];
  if (isMockProvider()) {
    result = await mockMarketDataProvider.getCandles({ ...params, symbol: sym });
    recordSuccess(true);
  } else {
    try {
      const raw = await getMarketDataProvider().getCandles({ ...params, symbol: sym });
      const mode = equityDisplayMode();
      result = raw.map((c) => ({ ...c, displayMode: mode, isDelayed: mode !== "realtime" }));
      recordSuccess(false);
    } catch (err) {
      recordError(err);
      result = await mockMarketDataProvider.getCandles({ ...params, symbol: sym });
      recordSuccess(true);
    }
  }
  memoryCache.set(key, result, TTL);
  return result;
}

// ── Movers ───────────────────────────────────────────────────────────────────

export interface MarketMoversMeta {
  provider: string;
  source: string;
  displayMode: MarketDataDisplayMode;
  isMock: boolean;
  warning: string | null;
}

export interface MarketMoversResponse {
  session: MarketSession;
  provider: string;
  source: string;
  displayMode: MarketDataDisplayMode;
  isMock: boolean;
  overnightEnabled: boolean;
  updatedAt: string;
  warning?: string;
  // Structured provenance for clients that prefer a single meta object. Mirrors
  // the top-level fields (kept for backward compatibility).
  meta: MarketMoversMeta;
  movers: MarketMover[];
}

/** Stamp each mover with its own source/session/displayMode so rows self-describe. */
function labelMovers(
  movers: MarketMover[],
  info: { session: MarketSession; source: string; displayMode: MarketDataDisplayMode },
): MarketMover[] {
  return movers.map((m) => ({
    ...m,
    session: info.session,
    source: info.source,
    displayMode: info.displayMode,
  }));
}

function buildMoversResponse(args: {
  session: MarketSession;
  provider: string;
  source: string;
  displayMode: MarketDataDisplayMode;
  isMock: boolean;
  updatedAt: string;
  warning?: string;
  movers: MarketMover[];
}): MarketMoversResponse {
  const { warning, ...rest } = args;
  return {
    ...rest,
    overnightEnabled,
    ...(warning ? { warning } : {}),
    meta: {
      provider: args.provider,
      source: args.source,
      displayMode: args.displayMode,
      isMock: args.isMock,
      warning: warning ?? null,
    },
    movers: labelMovers(args.movers, {
      session: args.session,
      source: args.source,
      displayMode: args.displayMode,
    }),
  };
}

export async function getMarketMovers(params: {
  session: MarketSession | "all";
  limit?: number;
}): Promise<MarketMoversResponse> {
  const session: MarketSession = params.session === "all" ? currentSession() : params.session;
  const limit = params.limit ?? 10;
  const key = `movers:${env.MARKET_DATA_PROVIDER}:${session}:${limit}`;
  const cached = memoryCache.get<MarketMoversResponse>(key);
  if (cached) return cached;

  const updatedAt = new Date().toISOString();
  const isOvernight = session === "overnight";

  let resp: MarketMoversResponse;
  if (isMockProvider()) {
    const movers = await mockMarketDataProvider.getMarketMovers({ session, limit });
    resp = buildMoversResponse({
      session,
      provider: "mock",
      source: "mock",
      displayMode: "mock",
      isMock: true,
      updatedAt,
      movers,
    });
    recordSuccess(true);
  } else {
    try {
      // Real provider — for overnight this uses the Databento overnight dataset.
      const movers = await getMarketDataProvider().getMarketMovers({ session, limit });
      const mode = equityDisplayMode();
      resp = buildMoversResponse({
        session,
        provider: env.MARKET_DATA_PROVIDER,
        source: env.MARKET_DATA_PROVIDER,
        displayMode: mode,
        isMock: false,
        updatedAt,
        ...(mode === "delayed" ? { warning: WARN_DELAYED } : {}),
        movers,
      });
      recordSuccess(false);
    } catch (err) {
      const msg = recordError(err);
      // Fall back to demo movers with a session-appropriate warning.
      const movers = await mockMarketDataProvider.getMarketMovers({ session, limit });
      const warning = isOvernight
        ? WARN_OVERNIGHT_FALLBACK
        : /not configured/i.test(msg)
          ? WARN_MISCONFIGURED
          : WARN_FALLBACK;
      resp = buildMoversResponse({
        session,
        provider: "mock",
        source: "mock",
        displayMode: "mock",
        isMock: true,
        updatedAt,
        warning,
        movers,
      });
      recordSuccess(true);
    }
  }
  memoryCache.set(key, resp, TTL);
  return resp;
}

// ── Option chain ─────────────────────────────────────────────────────────────

function labelOptionChain(chain: OptionChainResponse): OptionChainResponse {
  const mode = optionsDisplayMode();
  const isRealtime = mode === "realtime";
  return {
    ...chain,
    displayMode: mode,
    isDelayed: !isRealtime,
    ...(isRealtime ? {} : { warning: WARN_OPTIONS }),
    contracts: chain.contracts.map((c) => ({
      ...c,
      displayMode: mode,
      isDelayed: !isRealtime,
    })),
  };
}

export async function getOptionChain(params: {
  underlying: string;
  expiration?: string;
  type?: "call" | "put" | "all";
  minStrike?: number;
  maxStrike?: number;
}): Promise<OptionChainResponse> {
  const underlying = params.underlying.toUpperCase();
  const mode = isMockProvider() ? "mock" : optionsDisplayMode();
  const key = `options:${env.MARKET_DATA_PROVIDER}:${underlying}:${params.expiration ?? ""}:${params.type ?? "all"}:${params.minStrike ?? ""}:${params.maxStrike ?? ""}:${mode}`;
  const cached = memoryCache.get<OptionChainResponse>(key);
  if (cached) return cached;

  let result: OptionChainResponse;
  if (isMockProvider()) {
    result = await mockMarketDataProvider.getOptionChain({ ...params, underlying });
    recordSuccess(true);
  } else {
    try {
      const raw = await getMarketDataProvider().getOptionChain({ ...params, underlying });
      result = labelOptionChain(raw);
      recordSuccess(false);
    } catch (err) {
      const msg = recordError(err);
      result = await mockMarketDataProvider.getOptionChain({ ...params, underlying });
      result.warning = /not configured/i.test(msg) ? WARN_MISCONFIGURED : WARN_OPTIONS;
      recordSuccess(true);
    }
  }
  memoryCache.set(key, result, OPTIONS_TTL);
  return result;
}

export function clearMarketDataCache(): void {
  memoryCache.clear();
}
