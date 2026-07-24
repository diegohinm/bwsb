import { getMarketMovers } from "../services/market-data/marketData.service.js";
import type { MarketSession } from "../services/market-data/marketData.types.js";

/**
 * Warm the movers cache for each session. Manual/dev use only.
 *   npm run movers:refresh
 *
 * Provider failures fall back to mock inside the service — never crash here.
 */
const SESSIONS: MarketSession[] = ["premarket", "regular", "after_hours", "overnight"];

async function main(): Promise<void> {
  for (const session of SESSIONS) {
    try {
      const resp = await getMarketMovers({ session, limit: 10 });
      console.log(
        `[movers:refresh] ${session}: ${resp.movers.length} movers (source=${resp.source}${
          resp.warning ? `, warning="${resp.warning}"` : ""
        })`,
      );
    } catch (err) {
      console.error(`[movers:refresh] ${session} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

void main();
