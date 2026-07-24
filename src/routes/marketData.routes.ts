import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import {
  getQuote,
  getQuotes,
  getCandles,
  getMarketMovers,
  getOptionChain,
  getMarketProviderStatus,
  getMarketDataDiagnostics,
} from "../services/market-data/marketData.service.js";
import {
  CANDLE_TIMEFRAMES,
  MARKET_SESSIONS,
  type CandleTimeframe,
  type MarketSession,
} from "../services/market-data/marketData.types.js";

export const marketDataRouter = Router();

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

/** GET /api/market-data/quote/:symbol */
marketDataRouter.get(
  "/market-data/quote/:symbol",
  asyncHandler(async (req, res) => ok(res, await getQuote(req.params.symbol))),
);

/** GET /api/market-data/quotes?symbols=RDDT,NVDA,TSLA */
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
    return ok(res, await getQuotes(symbols));
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
    const sessionRaw = firstString(req.query.session) ?? "all";
    const session =
      sessionRaw === "all" || (MARKET_SESSIONS as string[]).includes(sessionRaw)
        ? (sessionRaw as MarketSession | "all")
        : "all";

    return ok(res, await getCandles({ symbol: req.params.symbol, timeframe: tf, from, to, session }));
  }),
);

/** GET /api/market-data/movers?session=premarket&limit=10 */
marketDataRouter.get(
  "/market-data/movers",
  asyncHandler(async (req, res) => {
    const sessionRaw = firstString(req.query.session) ?? "all";
    const session =
      sessionRaw === "all" || (MARKET_SESSIONS as string[]).includes(sessionRaw)
        ? (sessionRaw as MarketSession | "all")
        : "all";
    const limit = Math.min(50, numOrUndef(req.query.limit) ?? 10);
    return ok(res, await getMarketMovers({ session, limit }));
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
