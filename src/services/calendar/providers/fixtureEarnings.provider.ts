import { readFile } from "node:fs/promises";

import { env } from "../../../config/env.js";
import {
  normalizeStatus,
  normalizeTiming,
  parseDateKey,
} from "../calendarVocabulary.js";
import type {
  EarningsDataProvider,
  EarningsProviderStatus,
  ProviderEarningsEvent,
} from "../earningsData.provider.js";

/**
 * FILE-BACKED earnings source: a JSON document at EARNINGS_FIXTURE_PATH.
 *
 * Its purpose is a repeatable dataset for QA and for deployments that curate
 * dates by hand instead of paying for a feed. It reaches no network.
 *
 * It is treated as MOCK unless the file explicitly says otherwise
 * (`"isMock": false` at the top level). Defaulting the other way would let a
 * scratch file full of invented dates render as a real schedule — the operator
 * who curated real data can say so in one line, and nobody has to trust a
 * default to be honest.
 *
 * Shape:
 *   {
 *     "isMock": false,
 *     "source": "hand-curated 2026-08",
 *     "events": [
 *       { "symbol": "RDDT", "reportDate": "2026-08-19", "timing": "after_market",
 *         "status": "confirmed", "fiscalQuarter": "Q2", "fiscalYear": 2026 }
 *     ]
 *   }
 */

type FixtureFile = {
  isMock?: unknown;
  source?: unknown;
  events?: unknown;
};

let cache: { path: string; isMock: boolean; source: string | null; events: ProviderEarningsEvent[] } | null =
  null;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One raw fixture entry → a provider event, or null when unusable. */
function normalize(raw: unknown): ProviderEarningsEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const symbol = typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
  if (!symbol) return null;

  const reportDate = typeof r.reportDate === "string" ? r.reportDate.trim() : "";
  if (!parseDateKey(reportDate)) return null;

  // A clock time is carried through ONLY when it parses. A malformed one
  // becomes null rather than a guessed hour.
  let reportTime: string | null = null;
  if (typeof r.reportTime === "string" && r.reportTime.trim()) {
    const parsed = new Date(r.reportTime);
    if (!Number.isNaN(parsed.getTime())) reportTime = parsed.toISOString();
  }

  const fiscalYear = numberOrNull(r.fiscalYear);
  const fiscalQuarter =
    typeof r.fiscalQuarter === "string" && r.fiscalQuarter.trim()
      ? r.fiscalQuarter.trim()
      : null;

  return {
    symbol,
    companyName: typeof r.companyName === "string" ? r.companyName : null,
    reportDate,
    reportTime,
    timing: normalizeTiming(r.timing),
    status: normalizeStatus(r.status),
    fiscalQuarter,
    fiscalYear: fiscalYear === null ? null : Math.trunc(fiscalYear),
    epsEstimate: numberOrNull(r.epsEstimate),
    epsActual: numberOrNull(r.epsActual),
    revenueEstimate: numberOrNull(r.revenueEstimate),
    revenueActual: numberOrNull(r.revenueActual),
    externalId:
      typeof r.externalId === "string" && r.externalId.trim()
        ? r.externalId.trim()
        : `fixture:${symbol}:${fiscalYear ?? reportDate}${fiscalQuarter ? `:${fiscalQuarter}` : ""}`,
    source: typeof r.source === "string" ? r.source : null,
  };
}

async function load(): Promise<{
  isMock: boolean;
  source: string | null;
  events: ProviderEarningsEvent[];
}> {
  const path = env.EARNINGS_FIXTURE_PATH ?? "";
  if (!path) return { isMock: true, source: null, events: [] };
  if (cache && cache.path === path) return cache;

  const parsed = JSON.parse(await readFile(path, "utf8")) as FixtureFile;
  const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
  const value = {
    path,
    isMock: parsed.isMock === false ? false : true,
    source: typeof parsed.source === "string" ? parsed.source : null,
    events: rawEvents
      .map(normalize)
      .filter((e): e is ProviderEarningsEvent => e !== null),
  };
  cache = value;
  return value;
}

export const fixtureEarningsProvider: EarningsDataProvider = {
  name: "fixture",
  // Conservative at the type level; the worker asks the loaded file per event.
  isMock: true,

  async getStatus(): Promise<EarningsProviderStatus> {
    const path = env.EARNINGS_FIXTURE_PATH;
    if (!path) {
      return {
        name: "fixture",
        configured: false,
        isMock: true,
        detail: "EARNINGS_FIXTURE_PATH is not set.",
      };
    }
    try {
      const { events, isMock } = await load();
      return {
        name: "fixture",
        configured: true,
        isMock,
        detail: `${events.length} event(s) loaded from the configured fixture file.`,
      };
    } catch (err) {
      return {
        name: "fixture",
        configured: false,
        isMock: true,
        detail: `Fixture file could not be read: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  },

  async getEarningsEvents(
    start: string,
    end: string,
    symbols: string[],
  ): Promise<ProviderEarningsEvent[]> {
    const { events } = await load();
    const wanted = new Set(symbols.map((s) => s.toUpperCase()));
    return events.filter(
      (e) => wanted.has(e.symbol) && e.reportDate >= start && e.reportDate <= end,
    );
  },

  async getTickerEarnings(symbol: string): Promise<ProviderEarningsEvent[]> {
    const { events } = await load();
    const upper = symbol.toUpperCase();
    return events.filter((e) => e.symbol === upper);
  },
};

/** Whether the loaded fixture declares itself real. Used by the worker. */
export async function fixtureIsMock(): Promise<boolean> {
  try {
    return (await load()).isMock;
  } catch {
    return true;
  }
}

/** Test/reload hook — drops the cached file so the next read re-parses it. */
export function resetFixtureCache(): void {
  cache = null;
}
