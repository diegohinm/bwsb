import { env, extendedHoursEnabled } from "../../config/env.js";
import {
  readLatestMovers,
  readLatestQuotes,
  type StoredQuote,
} from "../../repositories/marketSnapshots.repository.js";
import { mockMarketDataProvider } from "./marketDataProvider.factory.js";
import {
  enqueueMarketDataJobs,
  MARKET_PRIORITY,
} from "./marketDataQueue.service.js";
import { increment } from "../../lib/metrics.js";
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
  /**
   * Older than QUOTE_TTL_SECONDS, and a refresh has been requested.
   *
   * IT IS STILL SERVED. Stale-while-revalidate: an out-of-date number that says
   * how out of date it is beats an empty panel, and beats making the reader wait
   * for a provider round-trip that may never complete. The refresh happens in
   * the worker, afterwards, for whoever looks next.
   */
  isStale: boolean;
}

/**
 * How old a stored quote may be before a read asks for a refresh.
 *
 * Not how old it may be before it stops being served — nothing here ever
 * withholds a row for being stale.
 *
 * Only while the market is OPEN. A Saturday-afternoon quote is thirty hours old
 * and perfectly correct: the last close is the current price, and treating its
 * age as staleness would queue a refresh for every symbol, every weekend, to
 * re-fetch a number that cannot have changed.
 */
function isStaleQuote(storedAt: string | null, marketOpen: boolean): boolean {
  if (!marketOpen) return false;
  if (!storedAt) return true;
  const age = Date.now() - new Date(storedAt).getTime();
  return age > env.QUOTE_TTL_SECONDS * 1_000;
}

/**
 * Ask the worker to refresh these symbols. NEVER AWAITED BY A RESPONSE.
 *
 * This is the single point where an API request can cause market data to be
 * fetched at all, and it is deliberately the weakest possible coupling: it
 * writes a row and returns. If the queue write fails, the reader still gets
 * their data and the scheduled sweep will pick the symbol up anyway — so this is
 * logged and dropped rather than surfaced.
 *
 * PRIORITY 1: somebody is looking at this symbol right now, which is the
 * strongest demand signal the system has.
 */
function requestRefresh(symbols: string[]): void {
  if (symbols.length === 0) return;
  if (!env.MARKET_STALE_WHILE_REVALIDATE || !env.MARKET_DATA_QUEUE_ENABLED) return;

  void enqueueMarketDataJobs(
    symbols.map((ticker) => ({
      ticker,
      jobType: "QUOTE" as const,
      priority: MARKET_PRIORITY.REALTIME,
    })),
  ).catch((err) => {
    console.error("[market-read] could not queue a refresh (serving stored data):", err);
  });
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
  const isStale = isStaleQuote(q.storedAt, marketOpen);
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
    isStale,
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
    // A symbol with no row at all is not "stale" — there is nothing to be stale.
    // It is missing, which `isMock` + the warning already say.
    isStale: false,
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

  // STALE-WHILE-REVALIDATE. The rows above have already been assembled and are
  // about to be returned; this only schedules work for the NEXT reader. A
  // symbol with no stored row is included, because "never fetched" is the case
  // most in need of a fetch.
  const needsRefresh = out.filter((q) => q.isStale || q.isMock).map((q) => q.symbol);
  increment("market_cache_hits", out.length - needsRefresh.length);
  increment("market_cache_misses", needsRefresh.length);
  increment("market_cache_stale_served", out.filter((q) => q.isStale).length);
  requestRefresh(needsRefresh);

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
