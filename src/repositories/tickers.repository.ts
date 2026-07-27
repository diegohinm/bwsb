import { prisma } from "../lib/prisma.js";
import { toDbRow, toDbRows } from "../lib/rows.js";
import type { Ticker } from "../types/domain.js";

/** Columns the ticker endpoints expose. */
const TICKER_COLUMNS = {
  ticker: true,
  companyName: true,
  exchange: true,
  isActive: true,
  isCommonWord: true,
  createdAt: true,
} as const;

/**
 * Data access for tickers and their derived daily/narrative context.
 *
 * Rows are returned with their database column names (see lib/rows.ts) because
 * the ticker/search routes serialize them straight onto the wire.
 */
export const tickersRepository = {
  async listAll(): Promise<Ticker[]> {
    const rows = await prisma.tickers.findMany({
      select: TICKER_COLUMNS,
      orderBy: { ticker: "asc" },
    });
    return toDbRows<Ticker>("Tickers", rows);
  },

  async findByTicker(ticker: string): Promise<Ticker | null> {
    const row = await prisma.tickers.findUnique({
      where: { ticker },
      select: TICKER_COLUMNS,
    });
    return row ? toDbRow<Ticker>("Tickers", row) : null;
  },

  /** Substring match on symbol or company, with symbol prefix matches first. */
  async search(term: string, limit = 20): Promise<Ticker[]> {
    const rows = await prisma.tickers.findMany({
      where: {
        OR: [
          { ticker: { contains: term, mode: "insensitive" } },
          { companyName: { contains: term, mode: "insensitive" } },
        ],
      },
      select: TICKER_COLUMNS,
      orderBy: { ticker: "asc" },
    });

    const prefix = term.toLowerCase();
    return toDbRows<Ticker>(
      "Tickers",
      // `ORDER BY (ticker ILIKE 'term%') DESC, ticker ASC` — a boolean sort key
      // Prisma cannot express, applied here over the already symbol-sorted rows.
      [...rows]
        .sort(
          (a, b) =>
            Number(b.ticker.toLowerCase().startsWith(prefix)) -
            Number(a.ticker.toLowerCase().startsWith(prefix)),
        )
        .slice(0, limit),
    );
  },

  /**
   * Global ticker/company search for the header search bar.
   * Ranking: exact ticker → ticker starts-with → company contains → ticker asc.
   */
  async searchTickers(term: string, limit = 8): Promise<Ticker[]> {
    const rows = await prisma.tickers.findMany({
      where: {
        OR: [
          { ticker: { startsWith: term, mode: "insensitive" } },
          { companyName: { contains: term, mode: "insensitive" } },
        ],
      },
      select: {
        ticker: true,
        companyName: true,
        exchange: true,
        isActive: true,
        isCommonWord: true,
      },
      orderBy: { ticker: "asc" },
    });

    const needle = term.toLowerCase();
    const priority = (t: { ticker: string; companyName: string | null }): number => {
      if (t.ticker.toLowerCase() === needle) return 0;
      if (t.ticker.toLowerCase().startsWith(needle)) return 1;
      if (t.companyName?.toLowerCase().includes(needle)) return 2;
      return 3;
    };

    // The CASE ranking, applied over rows already sorted by symbol so ties keep
    // their alphabetical order.
    return toDbRows<Ticker>(
      "Tickers",
      [...rows].sort((a, b) => priority(a) - priority(b)).slice(0, limit),
    );
  },

  /** Daily metrics for the trailing `days` days, oldest first. */
  async dailyMetrics(ticker: string, days = 14) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days);

    const rows = await prisma.tickerDailyMetrics.findMany({
      where: { ticker, day: { gte: since } },
      select: {
        ticker: true,
        day: true,
        mentions: true,
        uniqueAuthors: true,
        bullish: true,
        bearish: true,
        neutral: true,
        sentimentScore: true,
        mentionShare: true,
      },
      orderBy: { day: "asc" },
    });
    return toDbRows("TickerDailyMetrics", rows);
  },

  async narratives(ticker: string) {
    const rows = await prisma.narrativeEvents.findMany({
      where: { ticker },
      select: {
        id: true,
        ticker: true,
        narrative: true,
        narrativeType: true,
        strength: true,
        firstSeenAt: true,
        lastSeenAt: true,
        metadata: true,
      },
      orderBy: { strength: "desc" },
    });
    return toDbRows("NarrativeEvents", rows);
  },

  async ddQuality(ticker: string) {
    const rows = await prisma.ddQualityScores.findMany({
      where: { ticker },
      select: {
        id: true,
        redditPostId: true,
        ticker: true,
        score: true,
        category: true,
        explanation: true,
        evidenceScore: true,
        sourceScore: true,
        calculationScore: true,
        catalystScore: true,
        riskDisclosureScore: true,
        originalityScore: true,
        createdAt: true,
      },
      orderBy: { score: "desc" },
    });
    return toDbRows("DdQualityScores", rows);
  },
};
