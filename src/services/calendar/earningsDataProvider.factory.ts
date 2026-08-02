import { env, isProduction } from "../../config/env.js";
import { noneEarningsProvider } from "./providers/noneEarnings.provider.js";
import { mockEarningsProvider } from "./providers/mockEarnings.provider.js";
import { fixtureEarningsProvider } from "./providers/fixtureEarnings.provider.js";
import type { EarningsDataProvider } from "./earningsData.provider.js";

/**
 * Resolve the configured earnings provider from EARNINGS_DATA_PROVIDER.
 *
 * Two rules that differ from the market-data factory on purpose:
 *
 *   - the fallback is `none`, NOT mock. An unrecognized value must leave the
 *     calendar empty, because the alternative is publishing invented report
 *     dates for real companies.
 *   - `mock` is refused in production. A stray EARNINGS_DATA_PROVIDER=mock on a
 *     production service cannot be allowed to fill the public calendar with
 *     synthetic dates, badge or no badge.
 */
export function getEarningsDataProvider(): EarningsDataProvider {
  switch (env.EARNINGS_DATA_PROVIDER) {
    case "mock":
      if (isProduction) {
        console.warn(
          "[calendar] EARNINGS_DATA_PROVIDER=mock is ignored in production — falling back to none.",
        );
        return noneEarningsProvider;
      }
      return mockEarningsProvider;
    case "fixture":
      return fixtureEarningsProvider;
    case "none":
    default:
      return noneEarningsProvider;
  }
}

export { noneEarningsProvider, mockEarningsProvider, fixtureEarningsProvider };
