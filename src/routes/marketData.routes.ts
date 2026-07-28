import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import {
  getCandles,
  getOptionChain,
  getMarketProviderStatus,
  getMarketDataDiagnostics,
} from "../services/market-data/marketData.service.js";
import {
  getStoredQuote,
  getStoredQuotes,
  getStoredMovers,
} from "../services/market-data/marketRead.service.js";
import { extendedHoursEnabled } from "../config/env.js";
import {
  CANDLE_TIMEFRAMES,
  MARKET_SESSIONS,
  isExtendedHoursSession,
  type CandleTimeframe,
  type MarketSession,
} from "../services/market-data/marketData.types.js";

export const marketDataRouter = Router();

/** Sessions a client may actually ask for, given the feature flag. */
const AVAILABLE_SESSIONS: MarketSession[] = extendedHoursEnabled
  ? MARKET_SESSIONS
  : MARKET_SESSIONS.filter((s) => !isExtendedHoursSession(s));

/**
 * Parse a `?session=` parameter.
 *
 * Returns `{ error }` for a premarket/after-hours/overnight request while
 * extended hours are disabled — a clear 400 beats silently serving regular-session
 * data under an extended-hours label. Anything unrecognised falls back to "all",
 * as before.
 */
function parseSession(
  raw: string | undefined,
): { session: MarketSession | "all" } | { error: string } {
  const value = raw ?? "all";
  if (value === "all") return { session: "all" };

  if (!(MARKET_SESSIONS as string[]).includes(value)) return { session: "all" };

  if (!extendedHoursEnabled && isExtendedHoursSession(value as MarketSession)) {
    return {
      error:
        `Extended-hours sessions are disabled. This deployment serves the US regular ` +
        `session only (09:30–16:00 America/New_York). Use one of: ${AVAILABLE_SESSIONS.join(", ")}.`,
    };
  }
  return { session: value as MarketSession };
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}
function numOrUndef(value: unknown): number | undefined {
  const s = firstString(value);
  if (s == null || s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * GET /api/market-data/status — provider status + diagnostics (no secrets).
 * `?full=1` returns cache TTLs, license flags, and last success/error.
 */
marketDataRouter.get(
  "/market-data/status",
  asyncHandler(async (req, res) => {
    const full = firstString(req.query.full);
    if (full === "1" || full === "true") return ok(res, await getMarketDataDiagnostics());
    return ok(res, await getMarketProviderStatus());
  }),
);

/**
 * GET /api/market-data/quote/:symbol
 *
 * Reads `market_quotes_latest` — the ingestion worker's output. This route never
 * calls Databento; a symbol the worker has not published yet comes back as
 * clearly labeled demo data.
 */
marketDataRouter.get(
  "/market-data/quote/:symbol",
  asyncHandler(async (req, res) => ok(res, await getStoredQuote(req.params.symbol))),
);

/** GET /api/market-data/quotes?symbols=RDDT,NVDA,TSLA — reads the DB only. */
marketDataRouter.get(
  "/market-data/quotes",
  asyncHandler(async (req, res) => {
    const raw = firstString(req.query.symbols) ?? "";
    const symbols = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 50);
    if (symbols.length === 0) return fail(res, "Provide ?symbols=RDDT,NVDA,…", 400);
    return ok(res, await getStoredQuotes(symbols));
  }),
);

/** GET /api/market-data/candles/:symbol?timeframe=5m&from=&to=&session=all */
marketDataRouter.get(
  "/market-data/candles/:symbol",
  asyncHandler(async (req, res) => {
    const tf = (firstString(req.query.timeframe) ?? "1d") as CandleTimeframe;
    if (!(CANDLE_TIMEFRAMES as readonly string[]).includes(tf)) {
      return fail(res, `Unsupported timeframe. Use one of: ${CANDLE_TIMEFRAMES.join(", ")}.`, 400);
    }
    const now = Date.now();
    const from = firstString(req.query.from) ?? new Date(now - 30 * 864e5).toISOString();
    const to = firstString(req.query.to) ?? new Date(now).toISOString();

    const parsed = parseSession(firstString(req.query.session));
    if ("error" in parsed) return fail(res, parsed.error, 400);

    return ok(
      res,
      await getCandles({
        symbol: req.params.symbol,
        timeframe: tf,
        from,
        to,
        session: parsed.session,
      }),
    );
  }),
);

/**
 * GET /api/market-data/movers?session=regular&limit=10
 *
 * Reads the newest `market_movers_snapshots` row set for the session. Never
 * calls Databento — `updatedAt` is the snapshot's own timestamp, so the client
 * can see how fresh (or stale) the worker's last run is.
 *
 * With ENABLE_EXTENDED_HOURS off the only accepted sessions are `regular`,
 * `closed` and `all`; the response always carries the regular-session batch.
 */
marketDataRouter.get(
  "/market-data/movers",
  asyncHandler(async (req, res) => {
    const parsed = parseSession(firstString(req.query.session));
    if ("error" in parsed) return fail(res, parsed.error, 400);

    const limit = Math.min(50, numOrUndef(req.query.limit) ?? 10);
    return ok(res, await getStoredMovers({ session: parsed.session, limit }));
  }),
);

/** GET /api/options/:underlying/chain?expiration=&type=all&minStrike=&maxStrike= */
marketDataRouter.get(
  "/options/:underlying/chain",
  asyncHandler(async (req, res) => {
    const typeRaw = firstString(req.query.type);
    const type =
      typeRaw === "call" || typeRaw === "put" || typeRaw === "all" ? typeRaw : "all";
    return ok(
      res,
      await getOptionChain({
        underlying: req.params.underlying,
        expiration: firstString(req.query.expiration),
        type,
        minStrike: numOrUndef(req.query.minStrike),
        maxStrike: numOrUndef(req.query.maxStrike),
      }),
    );
  }),
);
