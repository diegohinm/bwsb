import { prisma } from "../lib/prisma.js";
import {
  buildCatalog,
  displayable,
  type TickerCatalog,
  type TickerMatch,
} from "../services/extraction/tickerExtraction.service.js";

/**
 * Reading the ticker catalog and writing the associations extraction produces.
 *
 * TWO WRITES, ONE TRANSACTION. Every association write updates both the join
 * table (the record: confidence, source, matched text) and `tickers[]` on the
 * content row (the display projection the GIN indexes serve). They are written
 * together so no reader can observe a state where a badge exists in one and not
 * the other.
 */

/** How long a loaded catalog is reused before being re-read. */
const CATALOG_TTL_MS = 5 * 60 * 1000;

let cached: { catalog: TickerCatalog; loadedAt: number } | null = null;

/**
 * The validation catalog, cached briefly.
 *
 * Ingestion calls this once per batch, not once per item, and the backfill
 * reuses one instance across every batch — the catalog changes when a migration
 * runs, not while a job is in flight.
 */
export async function loadTickerCatalog(force = false): Promise<TickerCatalog> {
  const now = Date.now();
  if (!force && cached && now - cached.loadedAt < CATALOG_TTL_MS) return cached.catalog;

  const [tickers, aliases] = await Promise.all([
    prisma.tickers.findMany({
      where: { isActive: true },
      select: { ticker: true, isCommonWord: true, isAmbiguous: true },
    }),
    prisma.tickerAliases.findMany({
      select: { alias: true, ticker: true, requiresContext: true },
    }),
  ]);

  // THE ONE PLACE the two stored ambiguity signals are combined.
  //
  //   is_ambiguous   written by the catalog refresh from
  //                  config/tickers/ambiguousTickers.ts — every one-character
  //                  symbol plus the hand-reviewed list.
  //   is_common_word curated earlier from false positives measured against
  //                  real posts (TEAM, ARM, COST, SNAP, LUV, …).
  //
  // They have different provenance but the same consequence for the detector:
  // a bare mention proves nothing. Merging them here keeps the RULE in one
  // config file while letting both sources of evidence feed it.
  const catalog = buildCatalog(
    tickers.map((t) => ({
      ticker: t.ticker,
      isCommonWord: t.isCommonWord === true || t.isAmbiguous === true,
    })),
    aliases,
  );
  cached = { catalog, loadedAt: now };
  return catalog;
}

/** Drop the cache — used by tests and after a catalog change. */
export function resetCatalogCache(): void {
  cached = null;
}

/** The symbols a reader may see, in render order. */
export function displaySymbols(matches: TickerMatch[]): string[] {
  return displayable(matches).map((m) => m.symbol);
}

type Row = { ticker: string; confidence: number; source: string; matchedText: string | null };

function toRows(matches: TickerMatch[]): Row[] {
  return matches.map((m) => ({
    ticker: m.symbol,
    confidence: m.confidence,
    source: m.source,
    matchedText: m.matchedText.slice(0, 120),
  }));
}

/**
 * Replace a post's associations with `matches`.
 *
 * Idempotent by construction: the existing rows are deleted and the current
 * ones inserted, so re-running the backfill over the same content converges
 * instead of accumulating. `skipDuplicates` covers the case where extraction
 * somehow offers the same symbol twice.
 */
export async function savePostTickers(
  socialPostId: string,
  matches: TickerMatch[],
): Promise<void> {
  const rows = toRows(matches);
  const symbols = displaySymbols(matches);

  await prisma.$transaction([
    prisma.socialPostTickers.deleteMany({ where: { socialPostId } }),
    ...(rows.length > 0
      ? [
          prisma.socialPostTickers.createMany({
            data: rows.map((r) => ({ socialPostId, ...r })),
            skipDuplicates: true,
          }),
        ]
      : []),
    prisma.socialPosts.update({ where: { id: socialPostId }, data: { tickers: symbols } }),
  ]);
}

/** The comment-side equivalent. */
export async function saveCommentTickers(
  socialCommentId: string,
  matches: TickerMatch[],
): Promise<void> {
  const rows = toRows(matches);
  const symbols = displaySymbols(matches);

  await prisma.$transaction([
    prisma.socialCommentTickers.deleteMany({ where: { socialCommentId } }),
    ...(rows.length > 0
      ? [
          prisma.socialCommentTickers.createMany({
            data: rows.map((r) => ({ socialCommentId, ...r })),
            skipDuplicates: true,
          }),
        ]
      : []),
    prisma.socialComments.update({
      where: { id: socialCommentId },
      data: { tickers: symbols },
    }),
  ]);
}

export type TickerBadge = {
  symbol: string;
  companyName: string | null;
  confidence: number;
};

/**
 * The badges to render for a set of posts, keyed by post id.
 *
 * One query for the whole page rather than one per card, and only associations
 * at or above the display threshold — the filter lives in SQL so a low-
 * confidence match cannot reach a response by accident.
 */
export async function badgesForPosts(
  postIds: string[],
  threshold: number,
): Promise<Map<string, TickerBadge[]>> {
  if (postIds.length === 0) return new Map();

  const rows = await prisma.socialPostTickers.findMany({
    where: { socialPostId: { in: postIds }, confidence: { gte: threshold } },
    select: {
      socialPostId: true,
      ticker: true,
      confidence: true,
      source: true,
      tickers: { select: { companyName: true } },
    },
  });

  return groupBadges(rows, (r) => r.socialPostId);
}

export async function badgesForComments(
  commentIds: string[],
  threshold: number,
): Promise<Map<string, TickerBadge[]>> {
  if (commentIds.length === 0) return new Map();

  const rows = await prisma.socialCommentTickers.findMany({
    where: { socialCommentId: { in: commentIds }, confidence: { gte: threshold } },
    select: {
      socialCommentId: true,
      ticker: true,
      confidence: true,
      source: true,
      tickers: { select: { companyName: true } },
    },
  });

  return groupBadges(rows, (r) => r.socialCommentId);
}

type BadgeRow = {
  ticker: string;
  confidence: unknown;
  source: string;
  tickers: { companyName: string | null } | null;
};

/**
 * Group rows by owner, ordered the way the feed renders them: cashtag first,
 * then confidence, then symbol. Position is not stored, so the ordering the
 * extractor computed is approximated here by source strength — close enough for
 * a badge row, and it keeps the table narrow.
 */
function groupBadges<T extends BadgeRow>(
  rows: T[],
  keyOf: (row: T) => string,
): Map<string, TickerBadge[]> {
  const out = new Map<string, TickerBadge[]>();

  for (const row of rows) {
    const key = keyOf(row);
    const list = out.get(key) ?? [];
    list.push({
      symbol: row.ticker,
      companyName: row.tickers?.companyName ?? null,
      // Prisma returns Decimal; the wire format is a plain number.
      confidence: Number(row.confidence),
    });
    out.set(key, list);
  }

  for (const [key, list] of out) {
    const bySource = new Map(rows.map((r) => [`${keyOf(r)}:${r.ticker}`, r.source]));
    list.sort((a, b) => {
      const aCash = bySource.get(`${key}:${a.symbol}`) === "cashtag";
      const bCash = bySource.get(`${key}:${b.symbol}`) === "cashtag";
      if (aCash !== bCash) return aCash ? -1 : 1;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  return out;
}
