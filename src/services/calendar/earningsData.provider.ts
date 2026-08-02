import type { EarningsStatus, EarningsTiming } from "./calendarVocabulary.js";

/**
 * Contract every earnings source implements.
 *
 * Callers depend only on this interface (via the factory), never on a concrete
 * provider, so the upstream can be swapped with one env var. Only the WORKER
 * ever holds one of these — the API reads `earnings_events` through Prisma, so
 * a page view can never become an upstream request.
 */

export type EarningsProviderName = "none" | "mock" | "fixture";

export interface ProviderEarningsEvent {
  symbol: string;
  companyName?: string | null;
  /** `YYYY-MM-DD` in the market timezone. */
  reportDate: string;
  /**
   * ISO instant, ONLY when the provider genuinely published a clock time.
   * Leave undefined otherwise — a missing time is stored as NULL and rendered
   * as "After Market Close" with no hour attached.
   */
  reportTime?: string | null;
  timing: EarningsTiming;
  status: EarningsStatus;
  fiscalQuarter?: string | null;
  fiscalYear?: number | null;
  epsEstimate?: number | null;
  epsActual?: number | null;
  revenueEstimate?: number | null;
  revenueActual?: number | null;
  /** Stable per-quarter key used to upsert. The factory fills a default. */
  externalId?: string | null;
  /** Where within the provider the row came from (endpoint, file, …). */
  source?: string | null;
}

export interface EarningsProviderStatus {
  name: EarningsProviderName;
  /** True only when this provider can actually return data. */
  configured: boolean;
  /** True when everything it returns is synthetic and must be labelled Demo. */
  isMock: boolean;
  /** Human-readable reason when `configured` is false. Never a secret. */
  detail?: string;
}

export interface EarningsDataProvider {
  readonly name: EarningsProviderName;
  /** True when every event it emits is synthetic. */
  readonly isMock: boolean;

  /** Health/config. Never returns secrets. */
  getStatus(): Promise<EarningsProviderStatus>;

  /**
   * Events for `symbols` whose report date falls in [start, end], both
   * `YYYY-MM-DD`. A provider that knows nothing about a symbol simply omits it.
   */
  getEarningsEvents(
    start: string,
    end: string,
    symbols: string[],
  ): Promise<ProviderEarningsEvent[]>;

  /** Every known event for one symbol, past and future. */
  getTickerEarnings(symbol: string): Promise<ProviderEarningsEvent[]>;
}
