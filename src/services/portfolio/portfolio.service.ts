/**
 * portfolio.service.ts
 *
 * Demo portfolio: computes unrealized P/L from the latest seeded market
 * snapshots and links each holding to its current retail/bet signal.
 */
import { portfolioRepository } from "../../repositories/portfolio.repository.js";
import { marketRepository } from "../../repositories/market.repository.js";
import { metricsRepository } from "../../repositories/metrics.repository.js";
import { DEMO_USER_ID } from "../../types/domain.js";

export interface PortfolioHolding {
  ticker: string;
  quantity: number;
  avg_cost: number;
  instrument: string;
  current_price: number | null;
  market_value: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pct: number | null;
  linked_signal: {
    signal_type: string;
    score: number | null;
    explanation: string | null;
  } | null;
  sentiment_changed: boolean;
}

export async function getDemoPortfolio(
  userId: string = DEMO_USER_ID,
): Promise<{ holdings: PortfolioHolding[]; total_market_value: number; total_unrealized_pl: number }> {
  const positions = (await portfolioRepository.positions(userId)) as Array<{
    ticker: string;
    quantity: number | null;
    avg_cost: number | null;
    instrument: string;
  }>;

  const holdings: PortfolioHolding[] = [];
  let totalValue = 0;
  let totalPl = 0;

  for (const pos of positions) {
    const ticker = pos.ticker;
    const quantity = Number(pos.quantity ?? 0);
    const avgCost = Number(pos.avg_cost ?? 0);

    const snapshot = await marketRepository.latestSnapshot(ticker);
    const price = snapshot ? Number(snapshot.price) : null;

    const marketValue = price != null ? round(price * quantity) : null;
    const cost = avgCost * quantity;
    const unrealizedPl = marketValue != null ? round(marketValue - cost) : null;
    const unrealizedPlPct =
      unrealizedPl != null && cost > 0 ? round((unrealizedPl / cost) * 100) : null;

    const signals = await metricsRepository.signalsForTicker(ticker);
    const primary = signals[0] ?? null;

    if (marketValue != null) totalValue += marketValue;
    if (unrealizedPl != null) totalPl += unrealizedPl;

    holdings.push({
      ticker,
      quantity,
      avg_cost: avgCost,
      instrument: pos.instrument,
      current_price: price,
      market_value: marketValue,
      unrealized_pl: unrealizedPl,
      unrealized_pl_pct: unrealizedPlPct,
      linked_signal: primary
        ? {
            signal_type: primary.signal_type,
            score: primary.score,
            explanation: primary.explanation,
          }
        : null,
      // Baseline heuristic: flag when a bearish/pump signal contradicts a long.
      sentiment_changed: primary
        ? (primary.signal_type === "pump_risk" && quantity > 0) ||
          Number(primary.score) < 40
        : false,
    });
  }

  return {
    holdings,
    total_market_value: round(totalValue),
    total_unrealized_pl: round(totalPl),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
