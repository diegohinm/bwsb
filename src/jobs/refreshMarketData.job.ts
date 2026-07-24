import { getQuotes, getMarketProviderStatus } from "../services/market-data/marketData.service.js";

/**
 * Warm the market-data cache for a core watchlist. Manual/dev use only.
 *   npm run market:refresh
 *
 * A provider failure must NOT crash this job — the service already falls back to
 * mock, so we just log and exit cleanly.
 */
const WATCHLIST = [
  "RDDT", "NVDA", "TSLA", "GME", "AMC", "PLTR", "HOOD", "SOFI",
  "SPY", "QQQ", "AAPL", "MSFT", "META", "AMZN", "AMD",
];

async function main(): Promise<void> {
  try {
    const status = await getMarketProviderStatus();
    console.log(`[market:refresh] provider=${status.provider} status=${status.status} mode=${status.displayMode}`);
    const quotes = await getQuotes(WATCHLIST);
    console.log(`[market:refresh] warmed ${quotes.length} quotes (isMock=${quotes[0]?.isMock ?? "n/a"})`);
  } catch (err) {
    console.error("[market:refresh] failed:", err instanceof Error ? err.message : err);
  }
}

void main();
