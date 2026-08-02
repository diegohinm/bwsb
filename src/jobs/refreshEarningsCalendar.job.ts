import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { getEarningsDataProvider } from "../services/calendar/earningsDataProvider.factory.js";
import { fixtureIsMock } from "../services/calendar/providers/fixtureEarnings.provider.js";
import { rankTrendingTickers } from "../services/calendar/trendingTickers.service.js";
import {
  MAX_TRENDING_LIMIT,
  normalizeStatus,
  normalizeTiming,
  parseDateKey,
  toDateKey,
} from "../services/calendar/calendarVocabulary.js";
import type { ProviderEarningsEvent } from "../services/calendar/earningsData.provider.js";

/**
 * WORKER JOB — refresh the stored earnings calendar.
 *
 * This is the ONLY place the earnings provider is called. The API reads
 * `earnings_events` through Prisma, so opening the calendar, paging a month or
 * flipping a filter never costs an upstream request.
 *
 * Three rules it will not break:
 *
 *   - A CONFIRMED date is never downgraded by a later estimate. Providers
 *     routinely re-publish a projection after a company has already confirmed;
 *     letting that overwrite would make the calendar less certain over time.
 *   - A provider failure NEVER clears the table. The job throws, the previous
 *     events keep serving, and the API reports `stale`.
 *   - Synthetic data is stored with `is_mock = true`, so it cannot be rendered
 *     as a real schedule.
 *
 * Its symbol set is derived, not hardcoded: whatever Reddit has been discussing
 * over the last 30 days, plus every symbol some user actually tracks.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back and forward the stored window reaches. */
const LOOKBACK_DAYS = 90;
const LOOKAHEAD_DAYS = 180;

/** Symbols worth spending provider budget on. Never a fixed list. */
async function trackedSymbols(now: Date): Promise<{
  symbols: string[];
  breakdown: Record<string, number>;
}> {
  const [trend, watchlist, positions, prefs] = await Promise.all([
    rankTrendingTickers({ timeframe: "30d", limit: MAX_TRENDING_LIMIT, now }),
    prisma.userWatchlistItems.findMany({ select: { ticker: true }, distinct: ["ticker"] }),
    prisma.virtualPositions.findMany({
      where: { ticker: { not: null } },
      select: { ticker: true },
      distinct: ["ticker"],
    }),
    prisma.userCalendarPreferences.findMany({ select: { selectedTickers: true } }),
  ]);

  const trending = trend.tickers.map((t) => t.symbol);
  const watched = watchlist.map((r) => r.ticker.toUpperCase());
  const held = positions
    .map((r) => r.ticker)
    .filter((t): t is string => Boolean(t))
    .map((t) => t.toUpperCase());
  const chosen = prefs.flatMap((p) => p.selectedTickers.map((t) => t.toUpperCase()));

  const symbols = [...new Set([...trending, ...watched, ...held, ...chosen])];
  return {
    symbols,
    breakdown: {
      trending: trending.length,
      watchlist: new Set(watched).size,
      positions: new Set(held).size,
      userSelected: new Set(chosen).size,
    },
  };
}

type Normalized = {
  symbol: string;
  companyName: string | null;
  reportDate: Date;
  reportTime: Date | null;
  timing: string;
  status: string;
  fiscalQuarter: string | null;
  fiscalYear: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  provider: string;
  source: string | null;
  externalId: string;
  isMock: boolean;
};

/**
 * Provider row → storable row, or null when it cannot be trusted.
 *
 * A missing/unknown timing stays `unknown` and a missing time stays NULL:
 * the calendar prints "After Market Close" rather than a manufactured 4:05 PM.
 */
function normalize(
  raw: ProviderEarningsEvent,
  provider: string,
  isMock: boolean,
): Normalized | null {
  const symbol = raw.symbol?.trim().toUpperCase();
  if (!symbol) return null;
  const reportDate = parseDateKey(raw.reportDate);
  if (!reportDate) return null;

  let reportTime: Date | null = null;
  if (raw.reportTime) {
    const parsed = new Date(raw.reportTime);
    if (!Number.isNaN(parsed.getTime())) reportTime = parsed;
  }

  const fiscalYear =
    typeof raw.fiscalYear === "number" && Number.isFinite(raw.fiscalYear)
      ? Math.trunc(raw.fiscalYear)
      : null;
  const fiscalQuarter = raw.fiscalQuarter?.trim() || null;

  return {
    symbol,
    companyName: raw.companyName?.trim() || null,
    reportDate,
    reportTime,
    timing: normalizeTiming(raw.timing),
    status: normalizeStatus(raw.status),
    fiscalQuarter,
    fiscalYear,
    epsEstimate: raw.epsEstimate ?? null,
    epsActual: raw.epsActual ?? null,
    revenueEstimate: raw.revenueEstimate ?? null,
    revenueActual: raw.revenueActual ?? null,
    provider,
    source: raw.source ?? null,
    // A stable per-quarter key: re-fetching the same quarter must update the
    // row, not add a second copy of it.
    externalId:
      raw.externalId?.trim() ||
      `${provider}:${symbol}:${fiscalYear ?? toDateKey(reportDate)}${fiscalQuarter ? `:${fiscalQuarter}` : ""}`,
    isMock,
  };
}

/** Real company names come from the tickers table, never from the mock feed. */
async function companyNames(symbols: string[]): Promise<Map<string, string>> {
  if (symbols.length === 0) return new Map();
  const rows = await prisma.tickers.findMany({
    where: { ticker: { in: symbols } },
    select: { ticker: true, companyName: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.companyName) out.set(r.ticker.toUpperCase(), r.companyName);
  }
  return out;
}

export async function refreshEarningsCalendar(): Promise<JobMetadata> {
  const provider = getEarningsDataProvider();
  const status = await provider.getStatus();

  if (!status.configured) {
    // NOT a failure: "no provider is configured" is a valid deployment. The
    // previous events (if any) stay exactly as they are.
    return {
      status: "success_without_change",
      provider: provider.name,
      configured: false,
      detail: status.detail ?? null,
      eventsWritten: 0,
    };
  }

  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const end = new Date(now.getTime() + LOOKAHEAD_DAYS * DAY_MS);

  const { symbols, breakdown } = await trackedSymbols(now);
  if (symbols.length === 0) {
    return {
      status: "success_without_change",
      provider: provider.name,
      detail: "No tracked symbols yet — no stored social content and no user selections.",
      eventsWritten: 0,
    };
  }

  // A fixture file may declare itself real; every other provider's mock flag is
  // its own. Either way the decision is made once, here, and stored per row.
  const isMock = provider.name === "fixture" ? await fixtureIsMock() : provider.isMock;

  const fetched = await provider.getEarningsEvents(toDateKey(start), toDateKey(end), symbols);

  const normalized = fetched
    .map((e) => normalize(e, provider.name, isMock))
    .filter((e): e is Normalized => e !== null);

  if (normalized.length === 0) {
    return {
      status: "success_without_change",
      provider: provider.name,
      symbolsRequested: symbols.length,
      detail: "Provider returned no usable events; stored events kept.",
      eventsWritten: 0,
    };
  }

  const names = await companyNames([...new Set(normalized.map((e) => e.symbol))]);
  const existing = await prisma.earningsEvents.findMany({
    where: { externalId: { in: normalized.map((e) => e.externalId) } },
    select: { id: true, externalId: true, status: true, reportDate: true, timing: true },
  });
  const byExternalId = new Map(
    existing.filter((e) => e.externalId).map((e) => [e.externalId as string, e]),
  );

  const creates: Normalized[] = [];
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  let confirmedPreserved = 0;

  for (const event of normalized) {
    const withName = {
      ...event,
      companyName: event.companyName ?? names.get(event.symbol) ?? null,
    };
    const prior = byExternalId.get(event.externalId);

    if (!prior) {
      creates.push(withName);
      continue;
    }

    // The preservation rule: an already-confirmed date is not replaced by a
    // fresh estimate. Estimates and actuals still refresh — only the date, the
    // timing and the status are held.
    const downgrade = prior.status === "confirmed" && withName.status === "estimated";
    if (downgrade) confirmedPreserved += 1;

    updates.push({
      id: prior.id,
      data: {
        companyName: withName.companyName,
        epsEstimate: withName.epsEstimate,
        epsActual: withName.epsActual,
        revenueEstimate: withName.revenueEstimate,
        revenueActual: withName.revenueActual,
        fiscalQuarter: withName.fiscalQuarter,
        fiscalYear: withName.fiscalYear,
        provider: withName.provider,
        source: withName.source,
        isMock: withName.isMock,
        fetchedAt: now,
        ...(downgrade
          ? {}
          : {
              reportDate: withName.reportDate,
              reportTime: withName.reportTime,
              timing: withName.timing,
              status: withName.status,
            }),
      },
    });
  }

  if (creates.length > 0) {
    await prisma.earningsEvents.createMany({ data: creates, skipDuplicates: true });
  }
  // Sequential on purpose: a fan-out of hundreds of updates exhausts the
  // connection pooler, which is a failure mode this job has no reason to risk.
  for (const u of updates) {
    await prisma.earningsEvents.update({ where: { id: u.id }, data: u.data });
  }

  return {
    provider: provider.name,
    isMock,
    symbolsRequested: symbols.length,
    symbolBreakdown: breakdown,
    window: { start: toDateKey(start), end: toDateKey(end) },
    eventsFetched: fetched.length,
    eventsWritten: creates.length + updates.length,
    created: creates.length,
    updated: updates.length,
    confirmedPreserved,
    refreshSeconds: env.EARNINGS_REFRESH_SECONDS,
  };
}

// Manual run: npm run calendar:earnings:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshEarningsCalendar", refreshEarningsCalendar);
}
