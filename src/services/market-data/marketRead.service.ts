import { env } from "../../config/env.js";
import {
  readLatestMovers,
  readLatestQuotes,
  type StoredQuote,
} from "../../repositories/marketSnapshots.repository.js";
import { mockMarketDataProvider } from "./marketDataProvider.factory.js";
import { currentSession } from "./marketData.util.js";
import { overnightEnabled, type MarketMoversResponse } from "./marketData.service.js";
import type {
  MarketDataDisplayMode,
  MarketQuote,
  MarketSession,
} from "./marketData.types.js";

/**
 * API-side market data reads — DATABASE ONLY.
 *
 * The API process must never call Databento on a user request; the ingestion
 * worker (src/worker.ts) refreshes `market_quotes_latest` and
 * `market_movers_snapshots` on a schedule and this module serves whatever is
 * there. Consequences, all deliberate:
 *
 *   - Responses carry the row's own `timestamp` (when the data was observed)
 *     plus `storedAt`/`snapshotAt` (when the worker wrote it), so a stale feed
 *     is visibly stale instead of silently presented as current.
 *   - A symbol/session the worker has not published yet falls back to clearly
 *     labeled demo data (isMock true + warning) — never a fabricated "real" row.
 *   - `displayMode` is clamped to non-realtime here as well as in the worker.
 */

const WARN_NOT_INGESTED =
  "Not published by the ingestion worker yet. Showing demo data.";
const WARN_PARTIAL =
  "Some symbols have not been published by the ingestion worker yet. Those rows show demo data.";

/** Delay label applied to everything the API serves. */
export const DELAY_MINUTES = env.MARKET_DATA_DELAY_MINUTES;

/** Never let a stored row claim real-time. */
function safeMode(mode: MarketDataDisplayMode): MarketDataDisplayMode {
  return mode === "realtime" ? "delayed" : mode;
}

export interface ApiMarketQuote extends MarketQuote {
  /** When the ingestion worker last wrote this row (null for demo fallbacks). */
  storedAt: string | null;
  /** Publication delay in minutes — drives the "Delayed 15m" badge. */
  delayMinutes: number | null;
}

function fromStored(q: StoredQuote): ApiMarketQuote {
  const displayMode = safeMode(q.displayMode);
  return {
    ...q,
    displayMode,
    isDelayed: displayMode !== "realtime",
    delayMinutes: q.delayMinutes ?? DELAY_MINUTES,
    ...(displayMode === "delayed"
      ? { warning: `Market data is delayed by ${q.delayMinutes ?? DELAY_MINUTES} minutes, not real-time.` }
      : {}),
  };
}

/** Labeled demo quote for a symbol the worker has not published. */
async function demoQuote(symbol: string): Promise<ApiMarketQuote> {
  const q = await mockMarketDataProvider.getQuote(symbol);
  return {
    ...q,
    displayMode: "mock",
    isMock: true,
    isDelayed: true,
    delayMinutes: null,
    storedAt: null,
    warning: WARN_NOT_INGESTED,
  };
}

/** Latest stored quotes, in the order requested. Missing symbols → demo rows. */
export async function getStoredQuotes(symbols: string[]): Promise<ApiMarketQuote[]> {
  const syms = symbols.map((s) => s.toUpperCase());
  const stored = await readLatestQuotes(syms);
  const bySymbol = new Map(stored.map((q) => [q.symbol.toUpperCase(), fromStored(q)]));

  const out: ApiMarketQuote[] = [];
  for (const sym of syms) {
    const hit = bySymbol.get(sym);
    out.push(hit ?? (await demoQuote(sym)));
  }

  // Flag the mixed case so the UI can badge partially-demo rows.
  if (out.some((q) => q.isMock) && out.some((q) => !q.isMock)) {
    for (const q of out) if (q.isMock) q.warning = WARN_PARTIAL;
  }
  return out;
}

export async function getStoredQuote(symbol: string): Promise<ApiMarketQuote> {
  const [q] = await getStoredQuotes([symbol]);
  return q;
}

/**
 * Latest stored movers for a session. Falls back to labeled demo movers when the
 * worker has not published that session yet.
 */
export async function getStoredMovers(params: {
  session: MarketSession | "all";
  limit?: number;
}): Promise<MarketMoversResponse> {
  const session: MarketSession =
    params.session === "all" ? currentSession() : params.session;
  const limit = params.limit ?? 10;

  const snapshot = await readLatestMovers(session, limit);

  if (!snapshot) {
    const movers = await mockMarketDataProvider.getMarketMovers({ session, limit });
    return {
      session,
      provider: "mock",
      source: "mock",
      displayMode: "mock",
      isMock: true,
      overnightEnabled,
      updatedAt: new Date().toISOString(),
      delayMinutes: null,
      warning: WARN_NOT_INGESTED,
      meta: {
        provider: "mock",
        source: "mock",
        displayMode: "mock",
        isMock: true,
        warning: WARN_NOT_INGESTED,
      },
      movers: movers.map((m) => ({
        ...m,
        session,
        source: "mock",
        displayMode: "mock" as MarketDataDisplayMode,
      })),
    };
  }

  const displayMode = safeMode(snapshot.displayMode);
  const delayMinutes = snapshot.delayMinutes ?? DELAY_MINUTES;
  const warning = snapshot.isMock
    ? "Showing demo data."
    : displayMode === "delayed"
      ? `Market data is delayed by ${delayMinutes} minutes, not real-time.`
      : undefined;

  return {
    session,
    provider: snapshot.provider,
    source: snapshot.source,
    displayMode,
    isMock: snapshot.isMock,
    overnightEnabled,
    // The snapshot's own timestamp — NOT "now" — so staleness is visible.
    updatedAt: snapshot.snapshotAt,
    delayMinutes: snapshot.isMock ? null : delayMinutes,
    ...(warning ? { warning } : {}),
    meta: {
      provider: snapshot.provider,
      source: snapshot.source,
      displayMode,
      isMock: snapshot.isMock,
      warning: warning ?? null,
    },
    movers: snapshot.movers.map((m) => ({
      symbol: m.symbol,
      price: m.price,
      changePct: m.changePct,
      volume: m.volume,
      session,
      timestamp: snapshot.snapshotAt,
      source: snapshot.source,
      displayMode,
    })),
  };
}
