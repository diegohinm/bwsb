import { env } from "../../config/env.js";
import {
  readLatestQuotes,
  type StoredQuote,
} from "../../repositories/marketSnapshots.repository.js";
import {
  readLatestTrendingTickers,
  type StoredTrendingTicker,
} from "../../repositories/socialSnapshots.repository.js";
import { fromStored } from "../market-data/marketRead.service.js";
import { isRegularSession } from "../market-data/marketData.util.js";
import type { MarketDataDisplayMode } from "../market-data/marketData.types.js";
import { latestRegularSessionOpen } from "../market/usMarketCalendar.js";
import type { PulseTimeframe, SocialStance } from "../social/socialData.types.js";

/**
 * Dashboard ticker strip: the moving tape at the top of the Dashboard.
 *
 * DATABASE ONLY, TWO READS, NO PROVIDER.
 *
 *   1. RANKING — the newest `trending_ticker_snapshots` batch, written by the
 *      worker (jobs/refreshTickerStrip.job.ts) from stored Reddit content and its
 *      sanitized ticker associations. Which symbols appear, and their mention
 *      counts, come from here and nowhere else.
 *   2. PRICES — `market_quotes_latest` for exactly those symbols, labelled by the
 *      same `fromStored` the quotes endpoint uses, so the strip can never
 *      disagree with another panel about what a stored row is.
 *
 * Prices are joined at READ time rather than taken from the snapshot so each
 * one carries its own provenance — provider, delay, the bar's observed time —
 * and so a quote the worker refreshed after the ranking was written is not
 * served older than it is.
 *
 * NOTHING HERE IS FABRICATED:
 *   - a row whose mentions came from the mock social provider (or from no
 *     recorded provider) is dropped, never badged and shown;
 *   - a symbol with no stored quote, or only a mock one, ships with
 *     `quote: null` — the mentions are real, the price is simply unknown;
 *   - a quote observed before the latest regular session is flagged stale and
 *     carries its date;
 *   - an old ranking is reported stale with its snapshot time.
 */

export interface TickerStripQuote {
  price: number;
  changePct: number | null;
  /** The bar's own time. Null only for a legacy row that never recorded one. */
  observedAt: string | null;
  provider: string;
  source: string;
  /** Never "realtime" — clamped by `fromStored`. */
  displayMode: MarketDataDisplayMode;
  delayMinutes: number | null;
  /** The market is closed (or the row is not a regular-session bar): a last close. */
  isLastRegularClose: boolean;
  /**
   * Observed before the most recent regular session that has opened (allowing
   * for the publication delay). On a Tuesday morning Monday's close is stale
   * in this sense — correct, but not today's price, so the UI shows its date.
   */
  isStale: boolean;
}

export interface TickerStripItem {
  symbol: string;
  /** Reddit items mentioning the symbol in the window. Always ≥ 1. */
  mentionCount: number;
  /** Dominant crowd stance, or null when the snapshot did not record one. */
  stance: SocialStance | null;
  /** Null when no real stored quote exists for the symbol. */
  quote: TickerStripQuote | null;
}

/**
 *   ok     a ranking exists and is younger than `staleAfterSeconds`
 *   stale  a ranking exists but the worker has not refreshed it in time
 *   empty  no usable ranking — the worker never published one, or every row
 *          in the newest batch was unverifiable
 */
export type TickerStripStatus = "ok" | "stale" | "empty";

export interface TickerStripMeta {
  timeframe: PulseTimeframe;
  limit: number;
  status: TickerStripStatus;
  /** When the worker produced the ranking (null when it never has). */
  snapshotAt: string | null;
  /** A ranking older than this is reported stale. */
  staleAfterSeconds: number;
  social: {
    /** Where the mentions came from, e.g. "arctic_shift". Null when empty. */
    provider: string | null;
  };
  market: {
    /** Provider of the quotes served. Null when no symbol has a quote. */
    provider: string | null;
    /** Never "realtime". Null when no symbol has a quote. */
    displayMode: MarketDataDisplayMode | null;
    delayMinutes: number | null;
    /** US regular session open right now. */
    marketOpen: boolean;
    /** Symbols served with a quote. */
    quoted: number;
    /** Symbols served without one. */
    missing: number;
    /** Quoted symbols whose price predates the latest regular session. */
    stale: number;
  };
  warning: string | null;
}

export interface TickerStripResponse {
  data: TickerStripItem[];
  meta: TickerStripMeta;
}

/** The worker stores up to 30 symbols per batch; read all, filter, then slice. */
const SNAPSHOT_READ_LIMIT = 30;

/**
 * How old a ranking may be before it is called stale: three missed refreshes,
 * and never under fifteen minutes. One late run is jitter; three is a worker
 * that has stopped publishing.
 */
export function stripStaleAfterSeconds(
  refreshSeconds: number = env.TICKER_STRIP_REFRESH_SECONDS,
): number {
  return Math.max(3 * refreshSeconds, 15 * 60);
}

const WARN_NO_SNAPSHOT =
  "No ingested Reddit ticker ranking yet — the ingestion worker has not published one.";
const WARN_NO_VERIFIED_ROWS =
  "The latest ranking has no rows from a verified Reddit source.";

/** A row whose mentions we can vouch for: a real provider and a real count. */
function isVerifiedRow(r: StoredTrendingTicker): r is StoredTrendingTicker & {
  mentionCount: number;
  providerSocial: string;
} {
  return (
    r.providerSocial != null &&
    r.providerSocial !== "mock" &&
    r.mentionCount != null &&
    r.mentionCount > 0
  );
}

/** A stored quote we can show as a price at all. */
function isRealQuote(q: StoredQuote): boolean {
  return !q.isMock && q.provider !== "mock" && q.price != null;
}

function toStripQuote(
  q: StoredQuote,
  marketOpen: boolean,
  sessionOpen: Date | null,
): TickerStripQuote {
  const labelled = fromStored(q, marketOpen);
  const observedMs = q.observedAt ? Date.parse(q.observedAt) : NaN;
  const isStale =
    Number.isNaN(observedMs) || (sessionOpen != null && observedMs < sessionOpen.getTime());

  return {
    price: labelled.price as number,
    changePct: labelled.changePct ?? null,
    observedAt: q.observedAt,
    provider: String(labelled.provider),
    source: labelled.source,
    displayMode: labelled.displayMode,
    delayMinutes: labelled.delayMinutes,
    isLastRegularClose: labelled.isLastRegularClose,
    isStale,
  };
}

/** Most frequent value, ties broken alphabetically so the answer is stable. */
function dominant(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export interface AssembleInput {
  timeframe: PulseTimeframe;
  limit: number;
  rows: StoredTrendingTicker[];
  quotes: StoredQuote[];
  now: Date;
  marketOpen: boolean;
  staleAfterSeconds: number;
}

/**
 * Pure assembly — everything that decides what the strip SAYS, with the
 * database and the clock passed in. Exported for tests.
 */
export function assembleTickerStrip(input: AssembleInput): TickerStripResponse {
  const { timeframe, limit, rows, quotes, now, marketOpen, staleAfterSeconds } = input;

  const snapshotAt = rows[0]?.snapshotAt ?? null;
  const verified = rows.filter(isVerifiedRow).slice(0, limit);

  // The bar a "current" price would come from: the latest session that had
  // opened by now MINUS the publication delay. In the first minutes after the
  // bell no delayed bar of today can exist yet, so yesterday's close is still
  // the newest possible price and must not be called stale.
  const delayMinutes = env.MARKET_DATA_DELAY_MINUTES;
  const sessionOpen = latestRegularSessionOpen(new Date(now.getTime() - delayMinutes * 60_000));

  const quoteBySymbol = new Map<string, TickerStripQuote>();
  for (const q of quotes) {
    if (!isRealQuote(q)) continue;
    quoteBySymbol.set(q.symbol.toUpperCase(), toStripQuote(q, marketOpen, sessionOpen));
  }

  const data: TickerStripItem[] = verified.map((r) => ({
    symbol: r.symbol.toUpperCase(),
    mentionCount: r.mentionCount,
    stance: r.stance,
    quote: quoteBySymbol.get(r.symbol.toUpperCase()) ?? null,
  }));

  const served = data.flatMap((d) => (d.quote ? [d.quote] : []));
  const ageSeconds = snapshotAt ? (now.getTime() - Date.parse(snapshotAt)) / 1000 : null;

  const status: TickerStripStatus =
    data.length === 0 ? "empty" : ageSeconds != null && ageSeconds > staleAfterSeconds ? "stale" : "ok";

  const missing = data.length - served.length;
  const staleQuotes = served.filter((q) => q.isStale).length;

  let warning: string | null = null;
  if (status === "empty") {
    warning = snapshotAt ? WARN_NO_VERIFIED_ROWS : WARN_NO_SNAPSHOT;
  } else if (status === "stale") {
    warning = `Ranking last refreshed ${snapshotAt}; the ingestion worker has not published a newer one.`;
  } else if (missing > 0) {
    warning = `${missing} symbol(s) have no stored quote yet — mentions only.`;
  }

  return {
    data,
    meta: {
      timeframe,
      limit,
      status,
      snapshotAt,
      staleAfterSeconds,
      social: {
        provider: dominant(verified.map((r) => r.providerSocial)),
      },
      market: {
        provider: dominant(served.map((q) => q.provider)),
        displayMode: served[0]?.displayMode ?? null,
        delayMinutes: served[0]?.delayMinutes ?? null,
        marketOpen,
        quoted: served.length,
        missing,
        stale: staleQuotes,
      },
      warning,
    },
  };
}

/**
 * The two database reads behind any view of the worker's Reddit ranking: the
 * newest batch, then stored quotes for exactly the rows that will be served.
 * Shared with the Dashboard's Trending Tickers panel so both read the same
 * ranking, with the same row rules and the same price for a symbol.
 */
export async function loadTickerStripInput(params: {
  timeframe: PulseTimeframe;
  limit: number;
  now?: Date;
}): Promise<AssembleInput> {
  const { timeframe, limit } = params;
  const now = params.now ?? new Date();

  const rows = await readLatestTrendingTickers(timeframe, SNAPSHOT_READ_LIMIT);
  const symbols = rows.filter(isVerifiedRow).slice(0, limit).map((r) => r.symbol);
  const quotes = await readLatestQuotes(symbols);

  return {
    timeframe,
    limit,
    rows,
    quotes,
    now,
    marketOpen: isRegularSession(now),
    staleAfterSeconds: stripStaleAfterSeconds(),
  };
}

export async function getDashboardTickerStrip(params: {
  timeframe: PulseTimeframe;
  limit: number;
  now?: Date;
}): Promise<TickerStripResponse> {
  return assembleTickerStrip(await loadTickerStripInput(params));
}
