import { env } from "../../config/env.js";
import { mockMarketDataProvider } from "./marketDataProvider.factory.js";
import { candleCoverage, type StoredCandle } from "./candleCache.service.js";
import {
  enqueueMarketDataJob,
  MARKET_PRIORITY,
} from "./marketDataQueue.service.js";
import type { CandleTimeframe, MarketCandle, MarketSession } from "./marketData.types.js";

/**
 * API-SIDE CANDLE READS — `market_candles`, then the queue, never the provider.
 *
 * What this replaced: `GET /api/market-data/candles/:symbol` called
 * `marketData.getCandles`, which went straight upstream on a user request behind
 * a ten-second in-memory cache. Under SERVICE_ROLE=api the provider guard threw
 * and the service quietly substituted MOCK BARS — so the production API was
 * answering chart requests with invented prices, correctly labeled but useless.
 *
 * Now: stored bars are served, the missing span (if any) is queued, and the
 * response says what it is. A reader never waits on Databento, and a closed bar
 * is bought once.
 */

export type ApiCandle = {
  symbol: string;
  timestamp: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  provider: string | null;
  isMock: boolean;
};

export type CandleReadResult = {
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
  candles: ApiCandle[];
  /** True when the whole requested span was already stored. */
  complete: boolean;
  /** Spans queued for the worker to fetch. Empty when nothing was missing. */
  pendingRanges: { from: string; to: string }[];
  isMock: boolean;
  warning?: string;
};

const WARN_NOT_CACHED =
  "These bars have not been downloaded yet. A refresh has been queued; showing demo data meanwhile.";
const WARN_PARTIAL =
  "Part of this range has not been downloaded yet. A refresh has been queued.";

function toApi(c: StoredCandle): ApiCandle {
  return {
    symbol: c.ticker,
    timestamp: c.timestamp.toISOString(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    provider: c.provider,
    isMock: false,
  };
}

/**
 * Ask the worker to fill a span. Fire-and-forget, like every other enqueue on a
 * read path: the reader's response does not depend on it succeeding.
 *
 * BACKGROUND priority. A chart is a request for history, most of which is
 * already on screen from the stored bars; it must not outrank the quote for a
 * symbol someone is actively watching.
 */
function queueGaps(
  symbol: string,
  timeframe: CandleTimeframe,
  gaps: { from: Date; to: Date }[],
): void {
  if (gaps.length === 0) return;
  if (!env.MARKET_DATA_QUEUE_ENABLED) return;

  for (const gap of gaps) {
    void enqueueMarketDataJob({
      ticker: symbol,
      jobType: "CANDLES",
      priority: MARKET_PRIORITY.BACKGROUND,
      params: { interval: timeframe, from: gap.from.toISOString(), to: gap.to.toISOString() },
    }).catch((err) => {
      console.error(`[market-read] could not queue candles for ${symbol}:`, err);
    });
  }
}

export async function readCandles(params: {
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
  session?: MarketSession | "all";
}): Promise<CandleReadResult> {
  const symbol = params.symbol.toUpperCase();
  const from = new Date(params.from);
  const to = new Date(params.to);

  const { candles, gaps } = await candleCoverage(symbol, params.timeframe, { from, to });
  queueGaps(symbol, params.timeframe, gaps);

  const base = {
    symbol,
    timeframe: params.timeframe,
    from: from.toISOString(),
    to: to.toISOString(),
    complete: gaps.length === 0,
    pendingRanges: gaps.map((g) => ({ from: g.from.toISOString(), to: g.to.toISOString() })),
  };

  // NOTHING STORED AT ALL. Demo bars, labeled — the same contract quotes use,
  // and for the same reason: a chart that renders obviously-fake data the user
  // is warned about is more honest than an empty panel that looks like a bug,
  // and far more honest than fake data presented as real.
  if (candles.length === 0) {
    const mock = await mockMarketDataProvider.getCandles({ ...params, symbol });
    return {
      ...base,
      candles: mock.map((c: MarketCandle) => ({
        symbol,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        provider: "mock",
        isMock: true,
      })),
      isMock: true,
      warning: WARN_NOT_CACHED,
    };
  }

  return {
    ...base,
    candles: candles.map(toApi),
    isMock: false,
    // Real bars, just not all of them. Reported rather than padded with mock
    // ones: a series that silently mixes measured and invented prices is worse
    // than a short series.
    ...(gaps.length > 0 ? { warning: WARN_PARTIAL } : {}),
  };
}
