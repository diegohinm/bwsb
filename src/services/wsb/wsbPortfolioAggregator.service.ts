import type {
  ExtractedOptionPosition,
  ExtractedPosition,
  ExtractedStockPosition,
} from "./positionExtractor.service.js";
import { VERIFICATION_LEVELS, type VerificationLevel } from "./wsb.types.js";

/**
 * Roll individual declared positions up into the rows the WSB Portfolio tab
 * shows. Provider-agnostic and side-effect free: the worker feeds it extracted
 * positions, it returns snapshot rows.
 *
 * Two figures deserve their definitions stated, because they are estimates and
 * the UI must not imply otherwise:
 *
 *   OPTION VALUE is NOTIONAL EXPOSURE — contracts × 100 × strike. We have no
 *   option price feed, and pretending a mark exists would be worse than an
 *   explicitly notional number. `contracts` comes only from a stated size, so a
 *   contract mentioned without one contributes 0 to exposure.
 *
 *   STOCK VALUE is shares × last known quote, and is null when we hold no quote
 *   for the symbol — never a guessed price.
 *
 * `text_only` positions (a declared side with no size) count toward `holders`
 * and sentiment but contribute nothing to size or exposure.
 */

const CONTRACT_MULTIPLIER = 100;

/** Best (most trustworthy) level wins when several items back one position. */
function bestLevel(a: VerificationLevel, b: VerificationLevel): VerificationLevel {
  return VERIFICATION_LEVELS.indexOf(a) <= VERIFICATION_LEVELS.indexOf(b) ? a : b;
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

export interface OptionSnapshotRow {
  underlying: string;
  optionType: "call" | "put";
  strike: number;
  expiration: Date;
  dte: number;
  durationBucket: ExtractedOptionPosition["durationBucket"];
  holders: number;
  quantity: number;
  estimatedValue: number;
  sentimentPct: number;
  verificationLevel: VerificationLevel;
}

export interface StockSnapshotRow {
  ticker: string;
  holders: number;
  shares: number;
  estimatedValue: number | null;
  bullishPct: number;
  topSubreddit: string | null;
  verificationLevel: VerificationLevel;
}

export interface PortfolioSummaryRow {
  traders: number;
  bullishPct: number;
  totalExposure: number;
  optionsPct: number;
  stocksPct: number;
  cryptoPct: number;
  zeroDteCount: number;
  weeklyCount: number;
  swingCount: number;
  leapsCount: number;
}

export interface PortfolioAggregate {
  summary: PortfolioSummaryRow;
  options: OptionSnapshotRow[];
  stocks: StockSnapshotRow[];
  /** Always empty for now — see `buildPortfolio`. */
  crypto: [];
}

function isOption(p: ExtractedPosition): p is ExtractedOptionPosition {
  return p.kind === "option";
}
function isStock(p: ExtractedPosition): p is ExtractedStockPosition {
  return p.kind === "stock";
}

function aggregateOptions(positions: ExtractedOptionPosition[]): OptionSnapshotRow[] {
  type Acc = {
    row: Omit<OptionSnapshotRow, "holders" | "sentimentPct">;
    holders: Set<string>;
    bullish: number;
    total: number;
  };
  const byContract = new Map<string, Acc>();

  for (const p of positions) {
    const key = `${p.underlying}|${p.optionType}|${p.strike}|${p.expiration.toISOString()}`;
    const acc = byContract.get(key);
    if (!acc) {
      byContract.set(key, {
        row: {
          underlying: p.underlying,
          optionType: p.optionType,
          strike: p.strike,
          expiration: p.expiration,
          dte: p.dte,
          durationBucket: p.durationBucket,
          quantity: p.contracts,
          estimatedValue: p.contracts * CONTRACT_MULTIPLIER * p.strike,
          verificationLevel: p.verificationLevel,
        },
        holders: new Set([p.authorHash]),
        bullish: p.bullish ? 1 : 0,
        total: 1,
      });
      continue;
    }
    acc.row.quantity += p.contracts;
    acc.row.estimatedValue += p.contracts * CONTRACT_MULTIPLIER * p.strike;
    acc.row.verificationLevel = bestLevel(acc.row.verificationLevel, p.verificationLevel);
    acc.holders.add(p.authorHash);
    if (p.bullish) acc.bullish += 1;
    acc.total += 1;
  }

  return [...byContract.values()]
    .map(({ row, holders, bullish, total }) => ({
      ...row,
      holders: holders.size,
      sentimentPct: pct(bullish, total),
    }))
    .sort((a, b) => b.estimatedValue - a.estimatedValue || b.holders - a.holders);
}

function aggregateStocks(
  positions: ExtractedStockPosition[],
  priceBySymbol: Map<string, number>,
): StockSnapshotRow[] {
  type Acc = {
    ticker: string;
    holders: Set<string>;
    shares: number;
    bullish: number;
    total: number;
    subreddits: Map<string, number>;
    level: VerificationLevel;
  };
  const byTicker = new Map<string, Acc>();

  for (const p of positions) {
    let acc = byTicker.get(p.ticker);
    if (!acc) {
      acc = {
        ticker: p.ticker,
        holders: new Set(),
        shares: 0,
        bullish: 0,
        total: 0,
        subreddits: new Map(),
        level: p.verificationLevel,
      };
      byTicker.set(p.ticker, acc);
    }
    acc.holders.add(p.authorHash);
    acc.shares += p.shares;
    if (p.bullish) acc.bullish += 1;
    acc.total += 1;
    acc.subreddits.set(p.subreddit, (acc.subreddits.get(p.subreddit) ?? 0) + 1);
    acc.level = bestLevel(acc.level, p.verificationLevel);
  }

  return [...byTicker.values()]
    .map((acc) => {
      const price = priceBySymbol.get(acc.ticker);
      const topSubreddit =
        [...acc.subreddits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        ticker: acc.ticker,
        holders: acc.holders.size,
        shares: acc.shares,
        estimatedValue: price !== undefined ? acc.shares * price : null,
        bullishPct: pct(acc.bullish, acc.total),
        topSubreddit,
        verificationLevel: acc.level,
      };
    })
    .sort(
      (a, b) =>
        (b.estimatedValue ?? 0) - (a.estimatedValue ?? 0) ||
        b.holders - a.holders ||
        b.shares - a.shares,
    );
}

/**
 * Build every WSB portfolio snapshot row from one window of extracted positions.
 *
 * `priceBySymbol` carries the last known quotes the worker already has; symbols
 * missing from it simply produce a null value.
 *
 * Crypto is intentionally empty: nothing in the current extraction pipeline can
 * identify a crypto holding with enough confidence, and the spec is explicit
 * that fabricated crypto data is worse than an empty state. When a crypto
 * extractor exists it fills this array and nothing else changes.
 */
export function buildPortfolio(
  positions: ExtractedPosition[],
  priceBySymbol: Map<string, number> = new Map(),
): PortfolioAggregate {
  const options = aggregateOptions(positions.filter(isOption));
  const stocks = aggregateStocks(positions.filter(isStock), priceBySymbol);

  const optionsExposure = options.reduce((s, r) => s + r.estimatedValue, 0);
  const stocksExposure = stocks.reduce((s, r) => s + (r.estimatedValue ?? 0), 0);
  const cryptoExposure = 0;
  const totalExposure = optionsExposure + stocksExposure + cryptoExposure;

  const traders = new Set(positions.map((p) => p.authorHash)).size;
  const bullishPositions = positions.filter((p) => p.bullish).length;

  // Allocation is a share of EXPOSURE, so the three add to 100 whenever there is
  // any exposure at all — and to 0 when there is none, rather than to a
  // meaningless 33/33/33.
  const alloc = (part: number) => pct(part, totalExposure);

  const counts = { zero_dte: 0, weekly: 0, swing: 0, leaps: 0 };
  for (const row of options) counts[row.durationBucket] += 1;

  return {
    summary: {
      traders,
      bullishPct: pct(bullishPositions, positions.length),
      totalExposure,
      optionsPct: alloc(optionsExposure),
      stocksPct: alloc(stocksExposure),
      cryptoPct: alloc(cryptoExposure),
      zeroDteCount: counts.zero_dte,
      weeklyCount: counts.weekly,
      swingCount: counts.swing,
      leapsCount: counts.leaps,
    },
    options,
    stocks,
    crypto: [],
  };
}
