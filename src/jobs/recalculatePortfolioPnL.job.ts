import { query } from "../lib/db.js";
import { virtualRepository } from "../repositories/virtual.repository.js";
import { getQuotes } from "../services/market-data/marketData.service.js";

/**
 * Recompute virtual-portfolio valuations from live market quotes. Manual/dev.
 *   npm run portfolio:recalculate
 *
 * Never hardcodes prices — every position is revalued through the market-data
 * service (which falls back to mock). Must not crash on provider OR db failure.
 */

const n = (v: unknown): number => {
  const x = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : 0;
};

async function main(): Promise<void> {
  let accounts: Array<{ id: string; cash_balance: number | string }> = [];
  try {
    accounts = await query<{ id: string; cash_balance: number | string }>(
      `SELECT id, cash_balance FROM public.virtual_accounts`,
    );
  } catch (err) {
    console.error("[portfolio:recalculate] cannot read accounts:", err instanceof Error ? err.message : err);
    return;
  }

  for (const account of accounts) {
    try {
      const positions = await virtualRepository.listPositions(account.id);
      if (positions.length === 0) continue;

      const symbols = [...new Set(positions.map((p) => p.ticker.toUpperCase()))];
      const quotes = await getQuotes(symbols);
      const priceBySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q.price ?? 0]));

      let positionsValue = 0;
      for (const p of positions) {
        const price = priceBySymbol.get(p.ticker.toUpperCase()) ?? n(p.avg_cost);
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

      const equityValue = n(account.cash_balance) + positionsValue;
      await virtualRepository.updateBalances(
        account.id,
        n(account.cash_balance),
        Math.round(equityValue * 100) / 100,
      );
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

void main();
