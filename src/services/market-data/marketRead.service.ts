import { env, extendedHoursEnabled } from "../../config/env.js";
import {
  readLatestMovers,
  readLatestQuotes,
  type StoredQuote,
} from "../../repositories/marketSnapshots.repository.js";
import { mockMarketDataProvider } from "./marketDataProvider.factory.js";
import { currentSession, isRegularSession } from "./marketData.util.js";
import { overnightEnabled, type MarketMoversResponse } from "./marketData.service.js";
import {
  isExtendedHoursSession,
  type MarketDataDisplayMode,
  type MarketQuote,
  type MarketSession,
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
/** Shown whenever a stored row is served outside 09:30–16:00 ET. */
const WARN_LAST_CLOSE =
  "Last regular-session close (09:30–16:00 ET). Not a live quote.";

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
  /**
   * True when this price is the last REGULAR-session close rather than a quote
   * from a currently-open market. The UI must label it and must not present it
   * as live.
   */
  isLastRegularClose: boolean;
}

/**
 * Never let a stored session value the product no longer exposes reach a
 * response. Legacy rows written before ENABLE_EXTENDED_HOURS was introduced can
 * still say "after_hours"; they are reported as "closed" instead of leaking a
 * session the client has no UI for. The row itself is left untouched in the DB.
 */
function safeSession(session: MarketSession): MarketSession {
  if (extendedHoursEnabled) return session;
  return isExtendedHoursSession(session) ? "closed" : session;
}

function fromStored(q: StoredQuote, marketOpen: boolean): ApiMarketQuote {
  const displayMode = safeMode(q.displayMode);
  const session = safeSession(q.session);
  // Outside 09:30–16:00 ET nothing stored can be a live quote: it is by
  // definition the last close we captured while the market was open.
  const isLastRegularClose = !marketOpen || session !== "regular";

  const delayWarning =
    displayMode === "delayed"
      ? `Market data is delayed by ${q.delayMinutes ?? DELAY_MINUTES} minutes, not real-time.`
      : undefined;
  // The last-close caveat outranks the delay caveat: it is the stronger claim
  // about what the number actually is.
  const warning = isLastRegularClose ? WARN_LAST_CLOSE : delayWarning;

  return {
    ...q,
    session,
    displayMode,
    isDelayed: displayMode !== "realtime",
    delayMinutes: q.delayMinutes ?? DELAY_MINUTES,
    isLastRegularClose,
    ...(warning ? { warning } : {}),
  };
}

/** Labeled demo quote for a symbol the worker has not published. */
async function demoQuote(symbol: string): Promise<ApiMarketQuote> {
  const q = await mockMarketDataProvider.getQuote(symbol);
  return {
    ...q,
    session: safeSession(q.session),
    displayMode: "mock",
    isMock: true,
    isDelayed: true,
    delayMinutes: null,
    storedAt: null,
    isLastRegularClose: false,
    warning: WARN_NOT_INGESTED,
  };
}

/** Latest stored quotes, in the order requested. Missing symbols → demo rows. */
export async function getStoredQuotes(symbols: string[]): Promise<ApiMarketQuote[]> {
  const syms = symbols.map((s) => s.toUpperCase());
  const stored = await readLatestQuotes(syms);
  const marketOpen = isRegularSession();
  const bySymbol = new Map(
    stored.map((q) => [q.symbol.toUpperCase(), fromStored(q, marketOpen)]),
  );

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
  const requested: MarketSession =
    params.session === "all" ? currentSession() : params.session;

  // With extended hours off, movers are a REGULAR-session concept only. Outside
  // market hours `currentSession()` yields "closed", for which no snapshot is
  // ever written, so the read is pinned to the last regular-session batch —
  // which is what "most recent regular session" means for a closed market.
  const session: MarketSession = extendedHoursEnabled
    ? requested
    : "regular";
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
