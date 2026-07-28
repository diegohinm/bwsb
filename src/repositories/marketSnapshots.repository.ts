import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import { extendedHoursEnabled } from "../config/env.js";
import {
  isExtendedHoursSession,
  type MarketDataDisplayMode,
  type MarketQuote,
  type MarketSession,
} from "../services/market-data/marketData.types.js";

/**
 * Market snapshot storage — the handoff between the ingestion worker and the API.
 *
 *   WORKER writes: saveQuotes (latest + history), saveMoversSnapshot
 *   API reads:     readLatestQuotes, readLatestMovers
 *
 * The API never calls Databento; it only reads what the worker last stored, so
 * every read also returns `observedAt`/`snapshotAt` and the row's own provenance
 * (provider / source / displayMode / delayMinutes / isMock) — a stale snapshot
 * is visible as stale rather than silently presented as current.
 *
 * EXTENDED HOURS: when ENABLE_EXTENDED_HOURS is off, every write path drops rows
 * whose session is premarket / after_hours / overnight. The guard lives here, at
 * the persistence boundary, so no caller can bypass it. Rows already in the
 * database are left untouched — this filters new writes, it never deletes
 * history.
 */

/**
 * Rows for a session the product does not currently expose. Dropped on write.
 * Returns everything unchanged once the flag is on.
 */
function withoutExtendedHours<T extends { session: MarketSession }>(rows: T[]): T[] {
  if (extendedHoursEnabled) return rows;
  return rows.filter((r) => !isExtendedHoursSession(r.session));
}

// ── Worker writes ────────────────────────────────────────────────────────────

export interface QuoteSnapshotInput {
  symbol: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  session: MarketSession;
  provider: string;
  source: string;
  displayMode: MarketDataDisplayMode;
  delayMinutes: number;
  isMock: boolean;
  isDelayed: boolean;
  observedAt: string;
}

/**
 * Upsert the latest quote per symbol AND append to the history table.
 *
 * A symbol the provider failed to return is simply not passed in, so its
 * previous row survives — "if the provider fails, keep previous DB data".
 */
export interface SaveQuotesResult {
  /** Rows whose price or observed_at moved (latest upserted + history appended). */
  updated: string[];
  /** Rows already holding this exact bar (latest refreshed, no history row). */
  unchanged: string[];
}

/**
 * Upsert the latest quote per symbol, appending to the history table ONLY when
 * the bar actually moved (different observed_at or a different price).
 *
 * Rationale: the worker runs every 60s but a 1-minute bar only changes once a
 * minute — and never while the market is closed. Appending unconditionally would
 * pile up thousands of identical history rows per day and make "when did this
 * price last change?" unanswerable.
 */
export async function saveQuotesIfChanged(
  quotes: QuoteSnapshotInput[],
): Promise<SaveQuotesResult> {
  const result: SaveQuotesResult = { updated: [], unchanged: [] };
  // Filter first: an extended-hours bar must not even count as "unchanged", or
  // it would refresh updated_at and make a stale regular close look re-confirmed.
  const candidates = withoutExtendedHours(quotes);
  if (candidates.length === 0) return result;

  const existing = new Map(
    (await readLatestQuotes(candidates.map((q) => q.symbol))).map((q) => [
      q.symbol.toUpperCase(),
      q,
    ]),
  );

  const changed: QuoteSnapshotInput[] = [];
  for (const q of candidates) {
    const prior = existing.get(q.symbol.toUpperCase());
    const sameBar =
      prior != null &&
      prior.timestamp === q.observedAt &&
      (prior.price ?? null) === (q.price ?? null);
    if (sameBar) result.unchanged.push(q.symbol.toUpperCase());
    else {
      changed.push(q);
      result.updated.push(q.symbol.toUpperCase());
    }
  }

  // Refresh `updated_at` on unchanged rows so "when did the worker last confirm
  // this?" stays answerable, without touching observed_at or the history.
  if (result.unchanged.length > 0) {
    await prisma.marketQuotesLatest.updateMany({
      where: { symbol: { in: result.unchanged } },
      data: { updatedAt: new Date() },
    });
  }

  if (changed.length > 0) await saveQuotes(changed);
  return result;
}

/** Columns shared by the "latest" row and its history row. */
function quoteColumns(q: QuoteSnapshotInput) {
  return {
    symbol: q.symbol.toUpperCase(),
    price: q.price,
    change: q.change,
    changePct: q.changePct,
    volume: q.volume,
    session: q.session,
    provider: q.provider,
    source: q.source,
    displayMode: q.displayMode,
    delayMinutes: q.delayMinutes,
    isMock: q.isMock,
    isDelayed: q.isDelayed,
    observedAt: q.observedAt,
  };
}

export async function saveQuotes(quotes: QuoteSnapshotInput[]): Promise<number> {
  // Extended-hours bars never reach the table while the flag is off, so the
  // stored "latest" stays the last REGULAR-session quote.
  const writable = withoutExtendedHours(quotes);
  if (writable.length === 0) return 0;

  for (const q of writable) {
    const columns = quoteColumns(q);
    const now = new Date();

    // One transaction per symbol: the "latest" row and its history row must not
    // disagree. Symbols are still written one at a time so that a failure part
    // way through leaves the symbols already processed persisted, exactly as
    // before — a single bad symbol never discards a whole refresh.
    await prisma.$transaction([
      prisma.marketQuotesLatest.upsert({
        where: { symbol: columns.symbol },
        create: { ...columns, updatedAt: now },
        update: { ...columns, updatedAt: now },
      }),
      prisma.marketQuoteSnapshots.create({ data: columns }),
    ]);
  }

  return writable.length;
}

export interface MoverSnapshotInput {
  session: MarketSession;
  symbol: string;
  price: number | null;
  changePct: number | null;
  volume: number | null;
  rank: number;
  provider: string;
  source: string;
  displayMode: MarketDataDisplayMode;
  delayMinutes: number;
  isMock: boolean;
}

/** Append one movers snapshot (all rows share the same snapshot_at). */
export async function saveMoversSnapshot(
  movers: MoverSnapshotInput[],
  snapshotAt: string,
): Promise<number> {
  const writable = withoutExtendedHours(movers);
  if (writable.length === 0) return 0;

  const created = await prisma.marketMoversSnapshots.createMany({
    data: writable.map((m) => ({
      session: m.session,
      symbol: m.symbol.toUpperCase(),
      price: m.price,
      changePct: m.changePct,
      volume: m.volume,
      rank: m.rank,
      provider: m.provider,
      source: m.source,
      displayMode: m.displayMode,
      delayMinutes: m.delayMinutes,
      isMock: m.isMock,
      snapshotAt,
    })),
  });
  return created.count;
}

// ── API reads ────────────────────────────────────────────────────────────────

export interface StoredQuote extends MarketQuote {
  /** When the worker last refreshed this row. */
  storedAt: string | null;
  delayMinutes: number | null;
}

/** Latest stored quote per symbol. Missing symbols are simply absent. */
export async function readLatestQuotes(symbols: string[]): Promise<StoredQuote[]> {
  if (symbols.length === 0) return [];

  const rows = await prisma.marketQuotesLatest.findMany({
    where: { symbol: { in: symbols.map((s) => s.toUpperCase()) } },
  });

  return rows.map((r) => ({
    symbol: r.symbol,
    assetType: "equity",
    provider: (r.provider ?? "mock") as StoredQuote["provider"],
    source: r.source ?? r.provider ?? "mock",
    displayMode: (r.displayMode ?? "delayed") as MarketDataDisplayMode,
    session: (r.session ?? "closed") as MarketSession,
    price: num(r.price),
    change: num(r.change),
    changePct: num(r.changePct),
    volume: num(r.volume),
    timestamp: (r.observedAt ?? r.updatedAt ?? new Date()).toISOString(),
    isMock: r.isMock,
    isDelayed: r.isDelayed,
    delayMinutes: r.delayMinutes,
    storedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
  }));
}

export interface StoredMovers {
  session: MarketSession;
  snapshotAt: string;
  provider: string;
  source: string;
  displayMode: MarketDataDisplayMode;
  delayMinutes: number | null;
  isMock: boolean;
  movers: {
    symbol: string;
    price: number | null;
    changePct: number | null;
    volume: number | null;
    rank: number | null;
  }[];
}

/** The newest movers snapshot for a session, or null when the worker never ran. */
export async function readLatestMovers(
  session: MarketSession,
  limit: number,
): Promise<StoredMovers | null> {
  // Find the newest snapshot_at for this session, then read only that batch —
  // rows from an older run must never be mixed into the current snapshot.
  const newest = await prisma.marketMoversSnapshots.aggregate({
    where: { session },
    _max: { snapshotAt: true },
  });
  if (!newest._max.snapshotAt) return null;

  const rows = await prisma.marketMoversSnapshots.findMany({
    where: { session, snapshotAt: newest._max.snapshotAt },
    orderBy: { rank: { sort: "asc", nulls: "last" } },
    take: limit,
  });
  if (rows.length === 0) return null;

  const first = rows[0];
  return {
    session: first.session as MarketSession,
    snapshotAt: first.snapshotAt.toISOString(),
    provider: first.provider ?? "mock",
    source: first.source ?? first.provider ?? "mock",
    displayMode: (first.displayMode ?? "delayed") as MarketDataDisplayMode,
    delayMinutes: first.delayMinutes,
    isMock: rows.some((r) => r.isMock),
    movers: rows.map((r) => ({
      symbol: r.symbol,
      price: num(r.price),
      changePct: num(r.changePct),
      volume: num(r.volume),
      rank: r.rank,
    })),
  };
}
