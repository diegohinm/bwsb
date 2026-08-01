import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import type {
  OptionSnapshotRow,
  PortfolioSummaryRow,
  StockSnapshotRow,
} from "../services/wsb/wsbPortfolioAggregator.service.js";
import type {
  DurationBucket,
  OptionType,
  VerificationLevel,
  WsbCryptoPosition,
  WsbOptionPosition,
  WsbPortfolioSummary,
  WsbStockPosition,
  WsbTimeframe,
} from "../services/wsb/wsb.types.js";

/**
 * WSB portfolio snapshot storage — the handoff between worker and API.
 *
 *   WORKER writes: saveWsbPortfolioSnapshot
 *   API reads:     readWsbPortfolioSummary, readWsbOptionPositions,
 *                  readWsbStockPositions, readWsbCryptoPositions
 *
 * Reads always resolve the newest `snapshot_at` for the timeframe FIRST and then
 * select only that batch, so rows from two different runs can never be blended
 * into one table. A failed run writes nothing, which is what keeps the previous
 * snapshot servable.
 */

export interface WsbSnapshotMeta {
  provider: string;
  source: string;
  isMock: boolean;
  warning: string | null;
  snapshotAt: string;
}

export interface SaveWsbPortfolioInput {
  timeframe: WsbTimeframe;
  provider: string;
  source: string;
  isMock: boolean;
  warning: string | null;
  summary: PortfolioSummaryRow;
  options: OptionSnapshotRow[];
  stocks: StockSnapshotRow[];
}

// ── Worker writes ────────────────────────────────────────────────────────────

/**
 * Append one complete portfolio snapshot for a timeframe.
 *
 * Wrapped in a transaction: a snapshot whose summary landed but whose position
 * rows did not would render a portfolio with exposure and no holdings. Either
 * the whole batch is readable or none of it is.
 */
export async function saveWsbPortfolioSnapshot(
  input: SaveWsbPortfolioInput,
  snapshotAt: string,
): Promise<{ summary: number; options: number; stocks: number }> {
  const common = {
    timeframe: input.timeframe,
    provider: input.provider,
    source: input.source,
    isMock: input.isMock,
    snapshotAt,
  };

  return prisma.$transaction(async (tx) => {
    await tx.wsbPortfolioSummarySnapshots.create({
      data: {
        ...common,
        warning: input.warning,
        traders: input.summary.traders,
        bullishPct: input.summary.bullishPct,
        totalExposure: input.summary.totalExposure,
        optionsPct: input.summary.optionsPct,
        stocksPct: input.summary.stocksPct,
        cryptoPct: input.summary.cryptoPct,
        zeroDteCount: input.summary.zeroDteCount,
        weeklyCount: input.summary.weeklyCount,
        swingCount: input.summary.swingCount,
        leapsCount: input.summary.leapsCount,
      },
    });

    const options = input.options.length
      ? await tx.wsbOptionPositionSnapshots.createMany({
          data: input.options.map((r) => ({
            ...common,
            underlying: r.underlying,
            optionType: r.optionType,
            strike: r.strike,
            expiration: r.expiration,
            dte: r.dte,
            durationBucket: r.durationBucket,
            holders: r.holders,
            quantity: r.quantity,
            estimatedValue: r.estimatedValue,
            sentimentPct: r.sentimentPct,
            verificationLevel: r.verificationLevel,
          })),
        })
      : { count: 0 };

    const stocks = input.stocks.length
      ? await tx.wsbStockPositionSnapshots.createMany({
          data: input.stocks.map((r) => ({
            ...common,
            ticker: r.ticker,
            holders: r.holders,
            shares: r.shares,
            estimatedValue: r.estimatedValue,
            bullishPct: r.bullishPct,
            topSubreddit: r.topSubreddit,
            verificationLevel: r.verificationLevel,
          })),
        })
      : { count: 0 };

    return { summary: 1, options: options.count, stocks: stocks.count };
  });
}

// ── API reads ────────────────────────────────────────────────────────────────

/**
 * Provenance of the newest stored run for a timeframe, or null when nothing was
 * stored. Read from the SUMMARY row rather than from the position rows: a
 * filtered page can legitimately be empty, and taking provenance from its first
 * row would then report a real snapshot as `mock`.
 */
async function newestRun(
  timeframe: WsbTimeframe,
): Promise<{ snapshotAt: Date; meta: WsbSnapshotMeta } | null> {
  const row = await prisma.wsbPortfolioSummarySnapshots.findFirst({
    where: { timeframe },
    orderBy: { snapshotAt: "desc" },
    select: { snapshotAt: true, provider: true, source: true, isMock: true, warning: true },
  });
  if (!row) return null;

  return {
    snapshotAt: row.snapshotAt,
    meta: {
      provider: row.provider ?? "mock",
      source: row.source ?? row.provider ?? "mock",
      isMock: row.isMock,
      warning: row.warning,
      snapshotAt: row.snapshotAt.toISOString(),
    },
  };
}

export async function readWsbPortfolioSummary(
  timeframe: WsbTimeframe,
): Promise<{ summary: WsbPortfolioSummary; meta: WsbSnapshotMeta } | null> {
  const row = await prisma.wsbPortfolioSummarySnapshots.findFirst({
    where: { timeframe },
    orderBy: { snapshotAt: "desc" },
  });
  if (!row) return null;

  return {
    summary: {
      timeframe,
      traders: row.traders,
      bullishPct: num(row.bullishPct) ?? 0,
      totalExposure: num(row.totalExposure) ?? 0,
      allocation: {
        optionsPct: num(row.optionsPct) ?? 0,
        stocksPct: num(row.stocksPct) ?? 0,
        cryptoPct: num(row.cryptoPct) ?? 0,
      },
      duration: {
        zeroDte: row.zeroDteCount,
        weekly: row.weeklyCount,
        swing: row.swingCount,
        leaps: row.leapsCount,
      },
    },
    meta: {
      provider: row.provider ?? "mock",
      source: row.source ?? row.provider ?? "mock",
      isMock: row.isMock,
      warning: row.warning,
      snapshotAt: row.snapshotAt.toISOString(),
    },
  };
}

export interface OptionPageQuery {
  timeframe: WsbTimeframe;
  durationBucket: DurationBucket | null;
  page: number;
  limit: number;
  sort: "value" | "holders" | "quantity" | "sentiment";
}

const OPTION_ORDER_BY: Record<
  OptionPageQuery["sort"],
  Record<string, "desc"> | Record<string, { sort: "desc"; nulls: "last" }>
> = {
  value: { estimatedValue: { sort: "desc", nulls: "last" } },
  holders: { holders: "desc" },
  quantity: { quantity: "desc" },
  sentiment: { sentimentPct: { sort: "desc", nulls: "last" } },
};

export async function readWsbOptionPositions(q: OptionPageQuery): Promise<{
  items: WsbOptionPosition[];
  total: number;
  meta: WsbSnapshotMeta | null;
}> {
  const run = await newestRun(q.timeframe);
  if (!run) return { items: [], total: 0, meta: null };
  const snapshotAt = run.snapshotAt;

  const where = {
    timeframe: q.timeframe,
    snapshotAt,
    ...(q.durationBucket ? { durationBucket: q.durationBucket } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.wsbOptionPositionSnapshots.findMany({
      where,
      orderBy: OPTION_ORDER_BY[q.sort],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.wsbOptionPositionSnapshots.count({ where }),
  ]);

  const offset = (q.page - 1) * q.limit;
  return {
    // Rank is the position in the FULL ordered set, not on the page, so page 2
    // starts at 11 rather than restarting at 1.
    items: rows.map((r, i) => ({
      rank: offset + i + 1,
      underlying: r.underlying,
      optionType: r.optionType as OptionType,
      strike: num(r.strike) ?? 0,
      expiration: r.expiration.toISOString().slice(0, 10),
      dte: r.dte,
      durationBucket: r.durationBucket as DurationBucket,
      holders: r.holders,
      quantity: r.quantity,
      value: num(r.estimatedValue) ?? 0,
      bullishPct: num(r.sentimentPct) ?? 0,
      changePct: num(r.changePct),
      verificationLevel: r.verificationLevel as VerificationLevel,
    })),
    total,
    meta: run.meta,
  };
}

export async function readWsbStockPositions(q: {
  timeframe: WsbTimeframe;
  page: number;
  limit: number;
}): Promise<{ items: WsbStockPosition[]; total: number; meta: WsbSnapshotMeta | null }> {
  const run = await newestRun(q.timeframe);
  if (!run) return { items: [], total: 0, meta: null };
  const where = { timeframe: q.timeframe, snapshotAt: run.snapshotAt };
  const [rows, total] = await Promise.all([
    prisma.wsbStockPositionSnapshots.findMany({
      where,
      orderBy: [{ estimatedValue: { sort: "desc", nulls: "last" } }, { holders: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.wsbStockPositionSnapshots.count({ where }),
  ]);

  const offset = (q.page - 1) * q.limit;
  return {
    items: rows.map((r, i) => ({
      rank: offset + i + 1,
      ticker: r.ticker,
      company: r.companyName,
      holders: r.holders,
      shares: num(r.shares) ?? 0,
      value: num(r.estimatedValue) ?? 0,
      bullishPct: num(r.bullishPct) ?? 0,
      changePct: num(r.changePct),
      topSubreddit: r.topSubreddit,
      verificationLevel: r.verificationLevel as VerificationLevel,
    })),
    total,
    meta: run.meta,
  };
}

export async function readWsbCryptoPositions(q: {
  timeframe: WsbTimeframe;
  page: number;
  limit: number;
}): Promise<{ items: WsbCryptoPosition[]; total: number; meta: WsbSnapshotMeta | null }> {
  const run = await newestRun(q.timeframe);
  if (!run) return { items: [], total: 0, meta: null };
  const where = { timeframe: q.timeframe, snapshotAt: run.snapshotAt };
  const [rows, total] = await Promise.all([
    prisma.wsbCryptoPositionSnapshots.findMany({
      where,
      orderBy: [{ estimatedValue: { sort: "desc", nulls: "last" } }, { holders: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.wsbCryptoPositionSnapshots.count({ where }),
  ]);

  const offset = (q.page - 1) * q.limit;
  return {
    items: rows.map((r, i) => ({
      rank: offset + i + 1,
      asset: r.assetName,
      symbol: r.symbol,
      holders: r.holders,
      quantity: num(r.quantity) ?? 0,
      value: num(r.estimatedValue) ?? 0,
      bullishPct: num(r.bullishPct) ?? 0,
      changePct: num(r.changePct),
      verificationLevel: r.verificationLevel as VerificationLevel,
    })),
    total,
    meta: run.meta,
  };
}

/** Last known quotes for the symbols a run touched — used to value holdings. */
export async function readLastQuotes(symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();
  const rows = await prisma.marketQuotesLatest.findMany({
    where: { symbol: { in: symbols } },
    select: { symbol: true, price: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const price = num(r.price);
    if (price !== null && price > 0) out.set(r.symbol, price);
  }
  return out;
}
