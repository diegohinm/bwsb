import {
  parseDateKey,
  toDateKey,
  type EarningsStatus,
  type EarningsTiming,
} from "../calendarVocabulary.js";
import type {
  EarningsDataProvider,
  EarningsProviderStatus,
  ProviderEarningsEvent,
} from "../earningsData.provider.js";

/**
 * DEMO earnings source. Everything it returns is synthetic and is stored with
 * `is_mock = true`, so the API can badge it "Demo data" and never present it as
 * a real schedule.
 *
 * It exists so the Calendar can be developed and QA'd without a paid earnings
 * feed. It is NOT the default provider, and `demoSeedAllowed` keeps it out of
 * production even if the variable is set there by accident.
 *
 * Deterministic: the same symbol always produces the same quarters, so a
 * re-run upserts rather than inventing a new schedule every 6 hours.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stable small integer from a symbol — no Math.random, so runs are repeatable. */
function seed(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i += 1) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const TIMINGS: EarningsTiming[] = [
  "before_market",
  "after_market",
  "after_market",
  "unknown",
];

/** Quarter boundaries a company might report just after. */
function quarterAnchor(year: number, quarter: number): Date {
  // Reports land a few weeks after the quarter ends: Q1 → late April, etc.
  return new Date(Date.UTC(year, quarter * 3, 20));
}

function buildEvent(symbol: string, year: number, quarter: number): ProviderEarningsEvent {
  const s = seed(`${symbol}:${year}:${quarter}`);
  const anchor = quarterAnchor(year, quarter);
  // Spread companies across a ~3 week reporting window.
  const reportDate = new Date(anchor.getTime() + (s % 21) * DAY_MS);
  const timing = TIMINGS[s % TIMINGS.length];

  // Only near-term quarters get confirmed; distant ones stay estimated, which
  // is how real schedules behave.
  const daysOut = Math.round((reportDate.getTime() - Date.now()) / DAY_MS);
  const status: EarningsStatus = daysOut <= 45 && s % 3 !== 0 ? "confirmed" : "estimated";

  // Actuals exist only for a quarter that has already reported.
  const reported = reportDate.getTime() < Date.now();
  const epsEstimate = Math.round(((s % 400) / 100 + 0.15) * 100) / 100;
  const revenueEstimate = (s % 900 + 100) * 1_000_000;

  return {
    symbol,
    // No company name: the worker fills it from the tickers table, which is a
    // real source. Inventing a legal name for a real symbol is not acceptable
    // even in demo mode.
    companyName: null,
    reportDate: toDateKey(reportDate),
    // Deliberately null. A demo provider must not fabricate a clock time; the
    // UI shows "After Market Close" with no hour.
    reportTime: null,
    timing,
    status,
    fiscalQuarter: `Q${quarter + 1}`,
    fiscalYear: year,
    epsEstimate,
    epsActual: reported ? Math.round((epsEstimate + ((s % 30) - 15) / 100) * 100) / 100 : null,
    revenueEstimate,
    revenueActual: reported ? revenueEstimate + ((s % 50) - 25) * 1_000_000 : null,
    externalId: `mock:${symbol}:${year}Q${quarter + 1}`,
    source: "mock",
  };
}

/** Every quarter for a symbol in a window, plus the two on either side. */
function eventsFor(symbol: string, start: Date, end: Date): ProviderEarningsEvent[] {
  const out: ProviderEarningsEvent[] = [];
  const firstYear = start.getUTCFullYear();
  const lastYear = end.getUTCFullYear();
  for (let year = firstYear - 1; year <= lastYear + 1; year += 1) {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const event = buildEvent(symbol, year, quarter);
      const date = parseDateKey(event.reportDate);
      if (!date) continue;
      if (date.getTime() < start.getTime() || date.getTime() > end.getTime()) continue;
      out.push(event);
    }
  }
  return out;
}

export const mockEarningsProvider: EarningsDataProvider = {
  name: "mock",
  isMock: true,

  async getStatus(): Promise<EarningsProviderStatus> {
    return {
      name: "mock",
      configured: true,
      isMock: true,
      detail: "Synthetic earnings dates for development and QA. Never real.",
    };
  },

  async getEarningsEvents(
    start: string,
    end: string,
    symbols: string[],
  ): Promise<ProviderEarningsEvent[]> {
    const from = parseDateKey(start);
    const to = parseDateKey(end);
    if (!from || !to) return [];
    return symbols.flatMap((symbol) => eventsFor(symbol.toUpperCase(), from, to));
  },

  async getTickerEarnings(symbol: string): Promise<ProviderEarningsEvent[]> {
    const now = new Date();
    const from = new Date(now.getTime() - 400 * DAY_MS);
    const to = new Date(now.getTime() + 400 * DAY_MS);
    return eventsFor(symbol.toUpperCase(), from, to);
  },
};
