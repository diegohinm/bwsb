import { prisma } from "../lib/prisma.js";
import { toDbRow, toDbRows } from "../lib/rows.js";
import type { MarketSnapshot } from "../types/domain.js";

/**
 * Data access for market data (snapshots, options, short interest, news…).
 *
 * Rows are returned with their database column names (see lib/rows.ts) because
 * the ticker/research routes serialize them straight onto the wire.
 *
 * "Latest per ticker" was `DISTINCT ON (ticker)`, which Prisma has no equivalent
 * for: group to find each ticker's newest snapshot_at, then fetch those rows.
 */
/** One row of option_contract_snapshots. The symbol column is `underlying`. */
export interface OptionContractRow {
  id: string;
  chain_snapshot_id: string | null;
  underlying: string;
  option_type: "call" | "put" | null;
  strike: number | null;
  expiration_date: Date | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_volatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  snapshot_at: Date;
}

export const marketRepository = {
  async latestSnapshot(ticker: string): Promise<MarketSnapshot | null> {
    const row = await prisma.marketSnapshots.findFirst({
      where: { ticker },
      orderBy: { snapshotAt: "desc" },
    });
    return row ? toDbRow<MarketSnapshot>("MarketSnapshots", row) : null;
  },

  async latestSnapshots(): Promise<MarketSnapshot[]> {
    const newestPerTicker = await prisma.marketSnapshots.groupBy({
      by: ["ticker"],
      _max: { snapshotAt: true },
    });
    const keys = newestPerTicker
      .filter((g) => g._max.snapshotAt !== null)
      .map((g) => ({ ticker: g.ticker, snapshotAt: g._max.snapshotAt! }));
    if (keys.length === 0) return [];

    const rows = await prisma.marketSnapshots.findMany({
      where: { OR: keys },
      orderBy: { ticker: "asc" },
    });
    return toDbRows<MarketSnapshot>("MarketSnapshots", rows);
  },

  /**
   * Contracts for an underlying. Options records key on `underlying` — the
   * canonical column name across the options tables (never ticker/symbol).
   */
  async optionContracts(underlying: string): Promise<OptionContractRow[]> {
    const rows = await prisma.optionContractSnapshots.findMany({
      where: { underlying },
      orderBy: [{ expirationDate: "asc" }, { strike: "asc" }],
    });
    return toDbRows<OptionContractRow>("OptionContractSnapshots", rows);
  },

  async shortInterest(ticker: string) {
    const row = await prisma.shortInterestSnapshots.findFirst({
      where: { ticker },
      orderBy: { snapshotAt: "desc" },
    });
    return row ? toDbRow("ShortInterestSnapshots", row) : null;
  },

  async shortInterestLatest() {
    const newestPerTicker = await prisma.shortInterestSnapshots.groupBy({
      by: ["ticker"],
      _max: { snapshotAt: true },
    });
    const keys = newestPerTicker
      .filter((g) => g._max.snapshotAt !== null)
      .map((g) => ({ ticker: g.ticker, snapshotAt: g._max.snapshotAt! }));
    if (keys.length === 0) return [];

    const rows = await prisma.shortInterestSnapshots.findMany({
      where: { OR: keys },
      orderBy: { ticker: "asc" },
    });
    return toDbRows("ShortInterestSnapshots", rows);
  },

  async newsForTicker(ticker: string, limit = 20) {
    const rows = await prisma.newsEvents.findMany({
      where: { ticker },
      orderBy: { publishedAt: "desc" },
      take: limit,
    });
    return toDbRows("NewsEvents", rows);
  },

  async insiderForTicker(ticker: string, limit = 20) {
    const rows = await prisma.insiderActivityEvents.findMany({
      where: { ticker },
      orderBy: { filedAt: "desc" },
      take: limit,
    });
    return toDbRows("InsiderActivityEvents", rows);
  },

  async externalSocial(ticker: string) {
    const row = await prisma.externalSocialSnapshots.findFirst({
      where: { ticker },
      orderBy: { snapshotAt: "desc" },
    });
    return row ? toDbRow("ExternalSocialSnapshots", row) : null;
  },

  async catalystsForTicker(ticker: string) {
    const rows = await prisma.catalystEvents.findMany({
      where: { ticker },
      orderBy: { eventDate: "asc" },
    });
    return toDbRows("CatalystEvents", rows);
  },
};
