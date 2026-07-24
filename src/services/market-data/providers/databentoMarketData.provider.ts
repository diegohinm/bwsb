import { env } from "../../../config/env.js";
import type { MarketDataProvider } from "../marketData.provider.js";
import { currentSession, round2 } from "../marketData.util.js";
import type {
  AssetType,
  CandleTimeframe,
  MarketCandle,
  MarketDataProviderStatus,
  MarketMover,
  MarketQuote,
  MarketSession,
  OptionChainResponse,
} from "../marketData.types.js";

/**
 * Databento market data provider (first real equities/options upstream).
 *
 * IMPORTANT
 *  - Only the BACKEND calls Databento. DATABENTO_API_KEY is read from env here
 *    and NEVER returned to the client, logged, or embedded in a payload.
 *  - The provider does NOT decide legal display policy — the service layer
 *    (marketData.service) applies license gating, display-mode labeling, and
 *    mock fallback uniformly for every provider. This class only fetches and
 *    maps, and throws a typed error when misconfigured or on failure so the
 *    service can fall back to mock safely.
 *  - Dataset/schema names are account-specific and fully env-driven — see
 *    DATABENTO_*_DATASET / DATABENTO_*_SCHEMA. Nothing here hardcodes them.
 *  - Live streaming (DATABENTO_LIVE_ENABLED) uses a different runtime/protocol
 *    (raw TCP + zstd DBN) that doesn't fit a request/response Express handler;
 *    it is intentionally left as a documented boundary (see `liveStreamTODO`).
 *    The REST/historical path below is the supported MVP surface.
 *
 * NOTE: Databento's exact HTTP timeseries response shape is account/schema
 * dependent and could not be validated live here. `mapRecord` reads defensively
 * and is the ONLY place to adjust if your account's fields differ.
 */

export class DatabentoNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`Databento is not configured (missing ${missing}).`);
    this.name = "DatabentoNotConfiguredError";
  }
}

const REQUEST_TIMEOUT_MS = 12_000;
const RETRY_DELAY_MS = 800;

type DbRecord = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export class DatabentoMarketDataProvider implements MarketDataProvider {
  readonly name = "databento" as const;

  private get apiKey(): string | undefined {
    return env.DATABENTO_API_KEY;
  }
  private get baseUrl(): string {
    return (env.DATABENTO_BASE_URL || "https://hist.databento.com").replace(/\/+$/, "");
  }
  private get equitiesDataset(): string | undefined {
    return env.DATABENTO_EQUITIES_DATASET;
  }

  /** Ready only when the API key AND the core equities dataset are present. */
  private get configured(): boolean {
    return Boolean(this.apiKey && this.equitiesDataset);
  }

  private missing(): string {
    if (!this.apiKey) return "DATABENTO_API_KEY";
    if (!this.equitiesDataset) return "DATABENTO_EQUITIES_DATASET";
    return "";
  }

  async getStatus(): Promise<MarketDataProviderStatus> {
    const updatedAt = new Date().toISOString();
    if (!this.configured) {
      return {
        provider: "databento",
        status: "misconfigured",
        displayMode: "mock",
        realtimeEnabled: false,
        optionsRealtimeEnabled: false,
        overnightEnabled: false,
        source: "databento",
        message: `${this.missing()} is not set — falling back to demo data.`,
        updatedAt,
      };
    }
    return {
      provider: "databento",
      status: "ready",
      displayMode: "delayed",
      realtimeEnabled: false, // effective value is computed by the service from license flags
      optionsRealtimeEnabled: false,
      overnightEnabled: false,
      source: "databento",
      message: "Databento provider configured.",
      updatedAt,
    };
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    const rows = await this.fetchEquities([symbol.toUpperCase()]);
    const rec = rows[0];
    if (!rec) throw new Error(`Databento returned no quote for ${symbol}`);
    return this.mapQuote(symbol.toUpperCase(), rec);
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    const upper = symbols.map((s) => s.toUpperCase());
    const rows = await this.fetchEquities(upper);
    // Map by symbol; any symbol Databento didn't return is dropped (service
    // decides whether to backfill from mock).
    const bySym = new Map<string, DbRecord>();
    for (const r of rows) {
      const s = String(r.symbol ?? r.raw_symbol ?? "").toUpperCase();
      if (s) bySym.set(s, r);
    }
    return upper.filter((s) => bySym.has(s)).map((s) => this.mapQuote(s, bySym.get(s)!));
  }

  async getCandles(params: {
    symbol: string;
    timeframe: CandleTimeframe;
    from: string;
    to: string;
    session?: MarketSession | "all";
  }): Promise<MarketCandle[]> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    const schema = ohlcvSchema(params.timeframe);
    const rows = await this.request({
      dataset: this.equitiesDataset!,
      symbols: params.symbol.toUpperCase(),
      schema,
      start: params.from,
      end: params.to,
    });
    return rows.map((r) => this.mapCandle(params.symbol.toUpperCase(), r));
  }

  async getMarketMovers(_params: {
    session: MarketSession | "all";
    limit?: number;
  }): Promise<MarketMover[]> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    // Databento is a raw market-data feed, not a curated "movers" screener.
    // Computing movers requires a universe scan + ranking job that is out of
    // scope for the request path — surface as unavailable so the service falls
    // back to the mock movers instead of blocking the page.
    throw new Error("Databento movers require a batch screener job (not implemented)");
  }

  async getOptionChain(_params: {
    underlying: string;
    expiration?: string;
    type?: "call" | "put" | "all";
    minStrike?: number;
    maxStrike?: number;
  }): Promise<OptionChainResponse> {
    if (!this.apiKey || !env.DATABENTO_OPTIONS_DATASET) {
      throw new DatabentoNotConfiguredError(
        !this.apiKey ? "DATABENTO_API_KEY" : "DATABENTO_OPTIONS_DATASET",
      );
    }
    // A full OPRA chain reconstruction from raw records is a substantial job and
    // is OPRA-license sensitive; keep it behind the service's options gating and
    // fall back to mock/EOD until a chain-builder is implemented.
    throw new Error("Databento option-chain reconstruction not implemented");
  }

  // ── Fetch + map ────────────────────────────────────────────────────────────

  /** Latest equities record(s) for symbols, via the configured dataset/schema. */
  private async fetchEquities(symbols: string[]): Promise<DbRecord[]> {
    const schema = env.DATABENTO_EQUITIES_SCHEMA || "trades";
    // Small trailing window; the service caches so this isn't hit per refresh.
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    return this.request({
      dataset: this.equitiesDataset!,
      symbols: symbols.join(","),
      schema,
      start,
      end,
    });
  }

  private mapQuote(symbol: string, r: DbRecord): MarketQuote {
    const price = num(r.price) ?? num(r.close) ?? num(r.last);
    const previousClose = num(r.prev_close) ?? num(r.previous_close);
    const change = price != null && previousClose != null ? round2(price - previousClose) : null;
    const changePct =
      price != null && previousClose ? round2(((price - previousClose) / previousClose) * 100) : null;
    return {
      symbol,
      assetType: guessAssetType(symbol),
      provider: "databento",
      source: "databento",
      displayMode: "delayed", // service overrides to realtime when licensed
      session: currentSession(),
      price,
      bid: num(r.bid) ?? num(r.bid_px),
      ask: num(r.ask) ?? num(r.ask_px),
      bidSize: num(r.bid_sz) ?? num(r.bid_size),
      askSize: num(r.ask_sz) ?? num(r.ask_size),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      previousClose,
      change,
      changePct,
      volume: num(r.volume) ?? num(r.size),
      timestamp: String(r.ts_event ?? r.timestamp ?? new Date().toISOString()),
      isMock: false,
      isDelayed: true,
    };
  }

  private mapCandle(symbol: string, r: DbRecord): MarketCandle {
    return {
      symbol,
      provider: "databento",
      source: "databento",
      displayMode: "delayed",
      open: num(r.open) ?? 0,
      high: num(r.high) ?? 0,
      low: num(r.low) ?? 0,
      close: num(r.close) ?? 0,
      volume: num(r.volume) ?? 0,
      timestamp: String(r.ts_event ?? r.timestamp ?? new Date().toISOString()),
      isMock: false,
      isDelayed: true,
    };
  }

  /**
   * Databento historical timeseries request (JSON lines) with timeout + one
   * retry. The key travels only in the Authorization header. Errors are
   * sanitized before they ever reach a log.
   */
  private async request(query: {
    dataset: string;
    symbols: string;
    schema: string;
    start: string;
    end: string;
  }): Promise<DbRecord[]> {
    const url = `${this.baseUrl}/v0/timeseries.get_range`;
    const body = new URLSearchParams({
      dataset: query.dataset,
      symbols: query.symbols,
      schema: query.schema,
      start: query.start,
      end: query.end,
      stype_in: env.DATABENTO_DEFAULT_STYPE_IN || "raw_symbol",
      stype_out: env.DATABENTO_DEFAULT_STYPE_OUT || "instrument_id",
      encoding: "json",
    });

    let lastErr: unknown;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            // Databento uses HTTP Basic with the API key as username.
            Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && attempt === 0) {
            lastErr = new Error(`Databento ${res.status}`);
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          throw new Error(`Databento request failed: ${res.status}`);
        }
        const text = await res.text();
        return parseJsonLines(text);
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Databento request failed");
  }
}

/** Live streaming boundary — see class docs. Not wired into the request path. */
export const liveStreamTODO =
  "Databento live streaming (DATABENTO_LIVE_ENABLED) requires a persistent DBN/zstd TCP client and a separate ingestion process; wire it as a background service, not an Express handler.";

function ohlcvSchema(tf: CandleTimeframe): string {
  switch (tf) {
    case "1m":
      return "ohlcv-1m";
    case "5m":
      return "ohlcv-1m"; // aggregate client-side; 5m schema is account-dependent
    case "15m":
      return "ohlcv-1m";
    case "1h":
      return "ohlcv-1h";
    case "1d":
    default:
      return "ohlcv-1d";
  }
}

function guessAssetType(symbol: string): AssetType {
  if (["SPY", "QQQ", "IWM", "DIA"].includes(symbol)) return "etf";
  return "equity";
}

function parseJsonLines(text: string): DbRecord[] {
  const out: DbRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as DbRecord);
    } catch {
      // Skip malformed lines rather than failing the whole batch.
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const databentoMarketDataProvider = new DatabentoMarketDataProvider();
