import { Prisma } from "@prisma/client";

import { prisma, disconnectPrisma } from "../lib/prisma.js";
import { virtualRepository } from "../repositories/virtual.repository.js";
import { getStoredQuotes } from "../services/market-data/marketRead.service.js";
import { recordEquitySnapshot } from "../services/portfolio/portfolioSummary.service.js";

/**
 * Recompute virtual-portfolio valuations from the latest ingested quotes.
 *   npm run portfolio:recalculate
 *
 * Reads `market_quotes_latest` (worker output) rather than calling a provider,
 * so it behaves identically in the API and worker processes. Never hardcodes
 * prices; must not crash on a missing quote or a db failure.
 */

const n = (v: unknown): number => {
  const x = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : 0;
};

async function main(): Promise<void> {
  let accounts: Array<{ id: string; userId: string; cashBalance: Prisma.Decimal }> = [];
  try {
    accounts = await prisma.virtualAccounts.findMany({
      select: { id: true, userId: true, cashBalance: true },
    });
  } catch (err) {
    console.error("[portfolio:recalculate] cannot read accounts:", err instanceof Error ? err.message : err);
    return;
  }

  for (const account of accounts) {
    try {
      const positions = await virtualRepository.listPositions(account.id);
      // An account with no positions still gets an equity reading — its cash is
      // its equity, and skipping it would leave a hole in the history that the
      // day/month comparisons read.
      if (positions.length === 0) {
        await recordEquitySnapshot(account.userId);
        continue;
      }

      // ticker is nullable on the column; a position without one simply has no
      // quote to look up and falls back to its average cost.
      const symbol = (p: { ticker: string | null }): string =>
        (p.ticker ?? "").toUpperCase();

      const symbols = [...new Set(positions.map(symbol))].filter(Boolean);
      const quotes = await getStoredQuotes(symbols);
      const priceBySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q.price ?? 0]));

      let positionsValue = 0;
      for (const p of positions) {
        const price = priceBySymbol.get(symbol(p)) ?? n(p.avg_cost);
        const mult = p.instrument === "option" ? 100 : 1;
        const qty = n(p.quantity);
        const marketValue = qty * price * mult;
        const unrealizedPl = (price - n(p.avg_cost)) * qty * mult;
        positionsValue += marketValue;
        await virtualRepository.setPositionValuation(
          p.id,
          Math.round(marketValue * 100) / 100,
          Math.round(unrealizedPl * 100) / 100,
        );
      }

      const equityValue = n(account.cashBalance) + positionsValue;
      await virtualRepository.updateBalances(
        account.id,
        n(account.cashBalance),
        Math.round(equityValue * 100) / 100,
      );
      // Append today's reading so "day P/L" has a baseline tomorrow. Written
      // HERE, in the worker — a read endpoint that appended would move the
      // baseline every time the page was opened.
      await recordEquitySnapshot(account.userId);

      const mock = quotes[0]?.isMock ? " (mock quotes)" : "";
      console.log(
        `[portfolio:recalculate] account ${account.id}: ${positions.length} positions, equity=${Math.round(equityValue)}${mock}`,
      );
    } catch (err) {
      console.error(
        `[portfolio:recalculate] account ${account.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

void main().finally(disconnectPrisma);
