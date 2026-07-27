import { env } from "../../../config/env.js";
import { assertProviderCallsAllowed } from "../../../config/serviceRole.js";
import type { MarketDataProvider } from "../marketData.provider.js";
import { DATABENTO_CONFIG } from "./databento.config.js";
import { currentSession, round2 } from "../marketData.util.js";
import type {
  AssetType,
  CandleTimeframe,
  DelayedBar,
  DelayedBarsResult,
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
 *  - Datasets/schemas come from the internal DATABENTO_CONFIG (see
 *    databento.config.ts). Only the API key and the two dataset ids are env
 *    driven; every other value (base URL, schemas, options dataset, symbology
 *    types, live/real-time toggles) is a code default so the .env stays minimal.
 *  - Live streaming uses a different runtime/protocol (raw TCP + zstd DBN) that
 *    doesn't fit a request/response Express handler; it is intentionally left as
 *    a documented boundary (see `liveStreamTODO`). The REST/historical path below
 *    is the supported MVP surface.
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

/**
 * Historical pulls for a whole watchlist move megabytes, and this provider is
 * driven by a BACKGROUND worker — nobody is waiting on an HTTP response, so the
 * budget is generous. (Measured: ~15-20s for multi-day 1-minute ranges.)
 */
const REQUEST_TIMEOUT_MS = 45_000;
const RETRY_DELAY_MS = 800;

/** Narrow window tried first for delayed bars (covers an open session). */
const DELAYED_LOOKBACK_MINUTES = 90;
/** Widened window for weekends/holidays — reaches the last trading session. */
const DELAYED_WIDE_LOOKBACK_DAYS = 5;
/** How far back to look for the previous daily close (change / changePct). */
const DAILY_LOOKBACK_DAYS = 10;
/** Dataset availability moves once a day; don't re-ask on every refresh. */
const RANGE_CACHE_MS = 10 * 60_000;
/** Symbol → instrument_id mappings are stable within a trading day. */
const SYMBOLOGY_CACHE_MS = 12 * 60 * 60_000;

/** Per-dataset availability range cache (module scope: one worker process). */
const rangeCache = new Map<
  string,
  { end: string | null; bySchema: Record<string, string>; expiresAt: number }
>();
/** Per-day symbology cache: instrument_id → raw symbol. */
const symbologyCache = new Map<string, { map: Map<number, string>; expiresAt: number }>();

type DbRecord = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/**
 * Databento JSON encodes prices as FIXED-POINT integers with a 1e-9 scale
 * (181.35 arrives as 181350000000). Some accounts/gateways emit already-scaled
 * decimals instead, so the scale is detected rather than assumed: a value with no
 * decimal point and an implausible magnitude for an equity price is divided by
 * 1e9. This is the one place to adjust if your account differs.
 */
const PRICE_SCALE = 1e9;
const FIXED_POINT_THRESHOLD = 1e6;

function price(v: unknown): number | null {
  const raw = num(v);
  if (raw === null) return null;
  const looksDecimal = typeof v === "string" && v.includes(".");
  if (!looksDecimal && Math.abs(raw) >= FIXED_POINT_THRESHOLD) {
    return round2(raw / PRICE_SCALE);
  }
  return round2(raw);
}

/**
 * Databento timestamps (`ts_event`) are nanoseconds since the Unix epoch, often
 * as a string to survive JSON's 2^53 limit. Returns an ISO string, or null when
 * the value is unusable — storing a raw nanosecond count as a timestamptz would
 * be rejected by Postgres.
 */
function tsToIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string" && v.includes("-")) {
    // Already an ISO-like string.
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const asString = String(v).trim();
  if (!/^\d+$/.test(asString)) return null;
  try {
    const ms = Number(BigInt(asString) / 1_000_000n);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}


export class DatabentoMarketDataProvider implements MarketDataProvider {
  readonly name = "databento" as const;

  private get apiKey(): string | undefined {
    return env.DATABENTO_API_KEY;
  }
  private get baseUrl(): string {
    return DATABENTO_CONFIG.baseUrl.replace(/\/+$/, "");
  }
  private get equitiesDataset(): string {
    return DATABENTO_CONFIG.equitiesDataset;
  }

  /**
   * Ready when the API key is present. The equities/overnight datasets always
   * have internal defaults, so the API key is the only thing that can be missing.
   */
  private get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private missing(): string {
    if (!this.apiKey) return "DATABENTO_API_KEY";
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

  /**
   * Latest available quote for one symbol. Backed by the same historical bars as
   * the ingestion path — Databento has no "current quote" REST endpoint, and the
   * live feed is intentionally not wired (see class docs).
   */
  async getQuote(symbol: string): Promise<MarketQuote> {
    const [quote] = await this.getQuotes([symbol]);
    if (!quote) throw new Error(`Databento returned no bar for ${symbol.toUpperCase()}`);
    return quote;
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    const upper = symbols.map((s) => s.toUpperCase());
    // No artificial cutoff here: the service layer owns the delay policy. The
    // dataset's own availability end still applies inside getDelayedBars.
    const bars = await this.getDelayedBars({
      symbols: upper,
      cutoffIso: new Date().toISOString(),
    });
    return upper
      .map((s) => bars.latestBySymbol.get(s))
      .filter((b): b is DelayedBar => Boolean(b))
      .map((bar) => this.barToQuote(bar));
  }

  /** Shape a bar as a quote. Change/changePct need a daily close — see service. */
  private barToQuote(bar: DelayedBar): MarketQuote {
    return {
      symbol: bar.symbol,
      assetType: guessAssetType(bar.symbol),
      provider: "databento",
      source: "databento",
      displayMode: "delayed", // service overrides only when licensed
      session: currentSession(new Date(bar.observedAt)),
      price: bar.close,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      previousClose: null,
      change: null,
      changePct: null,
      volume: bar.volume,
      timestamp: bar.observedAt,
      isMock: false,
      isDelayed: true,
    };
  }

  async getCandles(params: {
    symbol: string;
    timeframe: CandleTimeframe;
    from: string;
    to: string;
    session?: MarketSession | "all";
  }): Promise<MarketCandle[]> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    const overnight = params.session === "overnight";
    const rows = await this.request({
      // Overnight candles come from the dedicated overnight dataset/schema.
      dataset: overnight ? DATABENTO_CONFIG.overnightDataset : this.equitiesDataset,
      symbols: params.symbol.toUpperCase(),
      schema: overnight ? DATABENTO_CONFIG.overnightSchema : ohlcvSchema(params.timeframe),
      start: params.from,
      end: params.to,
    });
    return rows.map((r) => this.mapCandle(params.symbol.toUpperCase(), r));
  }

  async getMarketMovers(params: {
    session: MarketSession | "all";
    limit?: number;
  }): Promise<MarketMover[]> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    // Databento is a raw market-data feed, not a curated "movers" screener.
    // Computing movers (day OR overnight, via DATABENTO_OVERNIGHT_DATASET)
    // requires a universe scan + ranking batch job that is out of scope for the
    // request path — surface as unavailable so the service falls back to the mock
    // movers (with the right warning) instead of blocking the page.
    const scope = params.session === "overnight" ? "overnight " : "";
    throw new Error(`Databento ${scope}movers require a batch screener job (not implemented)`);
  }

  async getOptionChain(_params: {
    underlying: string;
    expiration?: string;
    type?: "call" | "put" | "all";
    minStrike?: number;
    maxStrike?: number;
  }): Promise<OptionChainResponse> {
    if (!this.apiKey) throw new DatabentoNotConfiguredError("DATABENTO_API_KEY");
    // A full OPRA chain reconstruction from raw records is a substantial job and
    // is OPRA-license sensitive; keep it behind the service's options gating and
    // fall back to mock/EOD until a chain-builder is implemented. The options
    // dataset/schema live in DATABENTO_CONFIG, not the environment.
    throw new Error("Databento option-chain reconstruction not implemented");
  }

  // ── Delayed (historical) ingestion path ────────────────────────────────────

  /**
   * DELAYED QUOTES — the path the ingestion worker uses.
   *
   * Reads OHLCV-1m bars from the HISTORICAL HTTP API (no live stream, no
   * real-time entitlement) and returns the newest bar at or before `cutoffIso`.
   * The cutoff is also the request's `end`, so data fresher than the published
   * delay is never even received.
   *
   * Range strategy:
   *   1. cutoff − 90 minutes → cutoff  (covers an open session)
   *   2. if that is empty:  cutoff − 5 days → cutoff  (weekends, holidays, and
   *      after-hours all resolve to the last available trading session)
   *
   * An empty result is NOT an error — it means the market has produced no bar in
   * that range, which the caller reports as "market closed / unchanged".
   */
  async getDelayedBars(params: {
    symbols: string[];
    cutoffIso: string;
    lookbackMinutes?: number;
    wideLookbackDays?: number;
  }): Promise<DelayedBarsResult> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());

    const symbols = params.symbols.map((s) => s.toUpperCase());
    const schema = DATABENTO_CONFIG.equitiesSchema;
    const cutoffMs = Date.parse(params.cutoffIso);
    const lookbackMinutes = params.lookbackMinutes ?? DELAYED_LOOKBACK_MINUTES;
    const wideDays = params.wideLookbackDays ?? DELAYED_WIDE_LOOKBACK_DAYS;

    // A historical dataset publishes up to its own availability end, which lags
    // real time (verified: EQUS.MINI ends at the previous UTC midnight). Asking
    // for anything past it is a hard 422, so the effective end is whichever of
    // (cutoff, availability end) is earlier. The cutoff is still a ceiling: we
    // never request data fresher than the published delay.
    const availableEnd = await this.datasetAvailableEnd(schema);
    const availableEndMs = availableEnd ? Date.parse(availableEnd) : cutoffMs;
    const effectiveEndMs = Math.min(cutoffMs, availableEndMs);
    const effectiveEnd = new Date(effectiveEndMs).toISOString();

    // EQUS.MINI does not support stype_out=raw_symbol, so records come back keyed
    // by instrument_id and have to be mapped back through symbology.resolve.
    const symbolById = await this.resolveInstrumentIds(symbols, effectiveEnd);

    /**
     * TIERED LOOKBACK, narrow → wide, and only for the symbols still missing.
     *
     * Measured against the live API: the 90 minutes before the availability end
     * are late after-hours and nearly empty (7 bars for NVDA, none for SPY),
     * while 5 days of 1-minute bars for 16 symbols is multi-megabyte and times
     * out. So each tier widens the range AND coarsens the schema, and re-requests
     * only the symbols that have no bar yet — cheap, and every symbol ends up
     * with the close of the last session it actually traded in.
     */
    const tiers = [
      { label: "intraday", schema, spanMs: lookbackMinutes * 60_000 },
      { label: "session", schema, spanMs: 12 * 60 * 60_000 },
      { label: "daily", schema: "ohlcv-1d", spanMs: wideDays * 24 * 60 * 60_000 },
    ];

    const latestBySymbol = new Map<string, DelayedBar>();
    let recordsFetched = 0;
    let widestStart = effectiveEnd;
    let tiersUsed = 0;

    for (const tier of tiers) {
      const pending = symbols.filter((s) => !latestBySymbol.has(s));
      if (pending.length === 0) break;

      tiersUsed += 1;
      const start = new Date(effectiveEndMs - tier.spanMs).toISOString();
      if (Date.parse(start) < Date.parse(widestStart)) widestStart = start;

      const rows = await this.request({
        dataset: this.equitiesDataset,
        symbols: pending.join(","),
        schema: tier.schema,
        start,
        end: effectiveEnd,
      });
      recordsFetched += rows.length;

      for (const r of rows) {
        const bar = toDelayedBar(r, symbolById);
        if (!bar) continue;
        if (!symbols.includes(bar.symbol)) continue;
        if (Date.parse(bar.observedAt) > effectiveEndMs) continue; // never past the cutoff
        const current = latestBySymbol.get(bar.symbol);
        if (!current || Date.parse(bar.observedAt) > Date.parse(current.observedAt)) {
          latestBySymbol.set(bar.symbol, bar);
        }
      }
    }

    return {
      latestBySymbol,
      windowStart: widestStart,
      windowEnd: effectiveEnd,
      recordsFetched,
      widened: tiersUsed > 1,
      availableEnd,
    };
  }

  /**
   * How far this dataset's data actually goes, for one schema. Cached briefly —
   * it only moves once a day, and the worker asks every refresh.
   */
  private async datasetAvailableEnd(schema: string): Promise<string | null> {
    const cached = rangeCache.get(this.equitiesDataset);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.bySchema[schema] ?? cached.end;
    }

    const payload = await this.getJson<{
      start?: string;
      end?: string;
      schema?: Record<string, { start?: string; end?: string }>;
    }>("metadata.get_dataset_range", { dataset: this.equitiesDataset });

    const normalize = (v: string | undefined): string | null => {
      if (!v) return null;
      // Databento returns nanosecond precision ("…T00:00:00.000000000Z"), which
      // Date.parse rejects; trim to milliseconds.
      const trimmed = v.replace(/(\.\d{3})\d+Z$/, "$1Z");
      const ms = Date.parse(trimmed);
      return Number.isNaN(ms) ? null : new Date(ms).toISOString();
    };

    const bySchema: Record<string, string> = {};
    for (const [name, r] of Object.entries(payload.schema ?? {})) {
      const end = normalize(r?.end);
      if (end) bySchema[name] = end;
    }
    const end = normalize(payload.end);
    rangeCache.set(this.equitiesDataset, {
      end,
      bySchema,
      expiresAt: Date.now() + RANGE_CACHE_MS,
    });
    return bySchema[schema] ?? end;
  }

  /** instrument_id → raw symbol, for the day the bars belong to. Cached. */
  private async resolveInstrumentIds(
    symbols: string[],
    onIso: string,
  ): Promise<Map<number, string>> {
    const day = onIso.slice(0, 10);
    const cacheKey = `${this.equitiesDataset}:${day}:${symbols.join(",")}`;
    const cached = symbologyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.map;

    const startDay = new Date(Date.parse(onIso) - DELAYED_WIDE_LOOKBACK_DAYS * 24 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);

    const payload = await this.postJson<{
      result?: Record<string, Array<{ s?: string }>>;
    }>("symbology.resolve", {
      dataset: this.equitiesDataset,
      symbols: symbols.join(","),
      stype_in: DATABENTO_CONFIG.stypeIn,
      stype_out: "instrument_id",
      start_date: startDay,
      end_date: day,
    });

    const map = new Map<number, string>();
    for (const [symbol, mappings] of Object.entries(payload.result ?? {})) {
      for (const m of mappings ?? []) {
        const id = Number(m?.s);
        if (Number.isFinite(id)) map.set(id, symbol.toUpperCase());
      }
    }
    symbologyCache.set(cacheKey, { map, expiresAt: Date.now() + SYMBOLOGY_CACHE_MS });
    return map;
  }

  /**
   * Previous daily close per symbol, used to compute change / changePct on a
   * delayed quote. Best-effort: callers treat a failure as "change unknown"
   * rather than failing the whole refresh.
   */
  async getPreviousDailyCloses(
    symbols: string[],
    beforeIso: string,
  ): Promise<Map<string, number>> {
    if (!this.configured) throw new DatabentoNotConfiguredError(this.missing());
    const upper = symbols.map((s) => s.toUpperCase());
    const availableEnd = await this.datasetAvailableEnd("ohlcv-1d");
    const beforeMs = Math.min(
      Date.parse(beforeIso),
      availableEnd ? Date.parse(availableEnd) : Date.parse(beforeIso),
    );
    const symbolById = await this.resolveInstrumentIds(upper, new Date(beforeMs).toISOString());
    const rows = await this.request({
      dataset: this.equitiesDataset,
      symbols: upper.join(","),
      schema: "ohlcv-1d",
      start: new Date(beforeMs - DAILY_LOOKBACK_DAYS * 24 * 60 * 60_000).toISOString(),
      end: new Date(beforeMs).toISOString(),
    });

    // Keep the SECOND-newest daily bar per symbol: the newest one is the session
    // the delayed quote itself belongs to, so "previous close" is the one before.
    const bySymbol = new Map<string, DelayedBar[]>();
    for (const r of rows) {
      const bar = toDelayedBar(r, symbolById);
      if (!bar || bar.close == null) continue;
      const arr = bySymbol.get(bar.symbol);
      if (arr) arr.push(bar);
      else bySymbol.set(bar.symbol, [bar]);
    }

    const out = new Map<string, number>();
    for (const [symbol, bars] of bySymbol) {
      bars.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
      const previous = bars[1] ?? bars[0];
      if (previous?.close != null) out.set(symbol, previous.close);
    }
    return out;
  }

  // ── Fetch + map ────────────────────────────────────────────────────────────

  private mapCandle(symbol: string, r: DbRecord): MarketCandle {
    const hd = (r.hd ?? {}) as DbRecord;
    return {
      symbol,
      provider: "databento",
      source: "databento",
      displayMode: "delayed",
      open: price(r.open) ?? 0,
      high: price(r.high) ?? 0,
      low: price(r.low) ?? 0,
      close: price(r.close) ?? 0,
      volume: num(r.volume) ?? 0,
      timestamp: tsToIso(hd.ts_event ?? r.ts_event ?? r.timestamp) ?? new Date().toISOString(),
      isMock: false,
      isDelayed: true,
    };
  }

  /**
   * Databento historical timeseries request (JSON lines) with timeout + one
   * retry. The key travels only in the Authorization header. Errors are
   * sanitized before they ever reach a log.
   */
  /** Authenticated GET returning JSON (metadata endpoints reject POST). */
  private async getJson<T>(path: string, params: Record<string, string>): Promise<T> {
    assertProviderCallsAllowed("Databento");
    const url = `${this.baseUrl}/${path}?${new URLSearchParams(params)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Authorization: this.authHeader() },
      });
      if (!res.ok) {
        throw new Error(
          `Databento ${path} failed: ${res.status} ${sanitizeBody(await safeText(res))}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Authenticated form POST returning JSON (symbology.resolve). */
  private async postJson<T>(path: string, params: Record<string, string>): Promise<T> {
    assertProviderCallsAllowed("Databento");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params),
      });
      if (!res.ok) {
        throw new Error(
          `Databento ${path} failed: ${res.status} ${sanitizeBody(await safeText(res))}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** HTTP Basic with the API key as the username. Never logged. */
  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
  }

  private async request(query: {
    dataset: string;
    symbols: string;
    schema: string;
    start: string;
    end: string;
    /** Override the output symbology (delayed bars need raw_symbol back). */
    stypeOut?: string;
  }): Promise<DbRecord[]> {
    // Hard process boundary: only the ingestion worker may reach Databento.
    // An API-role process serves market_quotes_latest / market_movers_snapshots.
    assertProviderCallsAllowed("Databento");

    // baseUrl already includes the /v0 API version segment (see DATABENTO_CONFIG).
    const url = `${this.baseUrl}/timeseries.get_range`;
    const body = new URLSearchParams({
      dataset: query.dataset,
      symbols: query.symbols,
      schema: query.schema,
      start: query.start,
      end: query.end,
      stype_in: DATABENTO_CONFIG.stypeIn,
      stype_out: query.stypeOut ?? DATABENTO_CONFIG.stypeOut,
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
            Authorization: this.authHeader(),
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
          // Include the upstream explanation: a 422 usually means the requested
          // range/schema is outside what the dataset offers, and without the body
          // that is undiagnosable. The body never contains the API key.
          throw new Error(
            `Databento request failed: ${res.status} ${sanitizeBody(await safeText(res))} ` +
              `[dataset=${query.dataset} schema=${query.schema} start=${query.start} end=${query.end}]`,
          );
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
  "Databento live streaming (DATABENTO_CONFIG.liveEnabled) requires a persistent DBN/zstd TCP client and a separate ingestion process; wire it as a background service, not an Express handler.";

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

/**
 * Normalize one raw record into a bar. Returns null when the record cannot be
 * attributed to a symbol or carries no usable timestamp — a half-read bar is
 * worse than a missing one.
 */
function toDelayedBar(r: DbRecord, symbolById?: Map<number, string>): DelayedBar | null {
  // Verified against the live API: OHLCV records nest their header, e.g.
  // {"hd":{"ts_event":"1784916000000000000","instrument_id":11667},"open":"209700000000",…}
  // Top-level fields are also accepted in case an account/gateway flattens them.
  const hd = (r.hd ?? {}) as DbRecord;

  let symbol = String(r.symbol ?? r.raw_symbol ?? "").toUpperCase();
  if (!symbol && symbolById) {
    const id = num(hd.instrument_id ?? r.instrument_id);
    if (id !== null) symbol = symbolById.get(id) ?? "";
  }
  if (!symbol) return null;

  const observedAt = tsToIso(
    hd.ts_event ?? r.ts_event ?? r.timestamp ?? hd.ts_recv ?? r.ts_recv,
  );
  if (!observedAt) return null;
  return {
    symbol,
    open: price(r.open),
    high: price(r.high),
    low: price(r.low),
    close: price(r.close),
    volume: num(r.volume) ?? num(r.size),
    observedAt,
  };
}

function guessAssetType(symbol: string): AssetType {
  if (["SPY", "QQQ", "IWM", "DIA"].includes(symbol)) return "etf";
  return "equity";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Trim an upstream error body and strip anything credential-shaped. */
function sanitizeBody(body: string): string {
  return body
    .replace(/\s+/g, " ")
    .replace(/(db-[A-Za-z0-9]+|Bearer\s+\S+|Basic\s+\S+)/gi, "***")
    .slice(0, 300)
    .trim();
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
