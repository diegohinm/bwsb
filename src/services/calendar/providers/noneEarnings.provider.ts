import type {
  EarningsDataProvider,
  EarningsProviderStatus,
  ProviderEarningsEvent,
} from "../earningsData.provider.js";

/**
 * The DEFAULT provider: no earnings source is configured.
 *
 * It returns nothing and says so. That is deliberate — the alternative default
 * would be synthetic events, and a calendar that quietly invents report dates
 * for real companies is worse than an empty one. The API surfaces the empty
 * state ("No earnings reports are scheduled…") and `meta.providerConfigured`
 * false, so the page can explain itself rather than look broken.
 */
export const noneEarningsProvider: EarningsDataProvider = {
  name: "none",
  isMock: false,

  async getStatus(): Promise<EarningsProviderStatus> {
    return {
      name: "none",
      configured: false,
      isMock: false,
      detail:
        "No earnings provider is configured. Set EARNINGS_DATA_PROVIDER to enable the calendar.",
    };
  },

  async getEarningsEvents(): Promise<ProviderEarningsEvent[]> {
    return [];
  },

  async getTickerEarnings(): Promise<ProviderEarningsEvent[]> {
    return [];
  },
};
