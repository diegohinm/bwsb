import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import {
  ARENA_ALL_SUBREDDITS,
  ARENA_PERIODS,
  ARENA_SCOPES,
  PUBLIC_DELAY_MINUTES,
  periodBounds,
  publicPriceCutoff,
  type ArenaPeriod,
  type ArenaScope,
} from "../services/arena/arenaPeriods.js";

/**
 * WORKER JOB — the public Arena ticker rankings.
 *
 * Builds four snapshots per run (two scopes × two periods): the top 10 symbols
 * by Reddit mentions, each enriched with its sentiment split, its share of the
 * period's mentions, a mention sparkline and delayed market performance.
 *
 * It calls no provider. Mentions come from stored `social_posts` /
 * `social_comments`, prices from stored `market_quote_snapshots`. That is what
 * lets the public page be served without an upstream request per visitor.
 *
 * Two honesty rules run through it:
 *   - a symbol with no eligible delayed price gets NULL prices and null
 *     performance, so the UI can print "—" instead of inventing a return;
 *   - the WSB scope reads only r/wallstreetbets, so its table can never be
 *     contaminated by the aggregate one.
 */

const TOP_N = 10;

type Item = {
  postedAt: Date;
  subreddit: string | null;
  stance: string | null;
  authorHash: string | null;
  tickers: string[];
};

type Agg = {
  symbol: string;
  mentions: number;
  bullish: number;
  neutral: number;
  bearish: number;
  subreddits: Set<string>;
  authors: Set<string>;
  /** Bucket start (ms) → mentions, for the sparkline. */
  buckets: Map<number, number>;
};

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

async function readItems(sinceIso: string, subreddits: readonly string[]): Promise<Item[]> {
  const where = {
    postedAt: { gte: new Date(sinceIso) },
    subreddit: { in: [...subreddits] },
  };
  const select = {
    postedAt: true,
    subreddit: true,
    stance: true,
    authorHash: true,
    tickers: true,
  } as const;

  const [posts, comments] = await Promise.all([
    prisma.socialPosts.findMany({ where, select }),
    prisma.socialComments.findMany({ where, select }),
  ]);
  return [...posts, ...comments]
    .filter((i): i is Item => Boolean(i.postedAt))
    .map((i) => ({ ...i, tickers: i.tickers ?? [] }));
}

/** One mention per content item per symbol; repetition must not inflate volume. */
function aggregate(items: Item[], bucketMs: number): Map<string, Agg> {
  const bySymbol = new Map<string, Agg>();

  for (const item of items) {
    const bucket = Math.floor(item.postedAt.getTime() / bucketMs) * bucketMs;
    for (const raw of new Set(item.tickers)) {
      const symbol = raw.toUpperCase();
      let agg = bySymbol.get(symbol);
      if (!agg) {
        agg = {
          symbol,
          mentions: 0,
          bullish: 0,
          neutral: 0,
          bearish: 0,
          subreddits: new Set(),
          authors: new Set(),
          buckets: new Map(),
        };
        bySymbol.set(symbol, agg);
      }
      agg.mentions += 1;
      if (item.stance === "bullish") agg.bullish += 1;
      else if (item.stance === "bearish") agg.bearish += 1;
      else if (item.stance === "neutral") agg.neutral += 1;
      if (item.subreddit) agg.subreddits.add(item.subreddit);
      if (item.authorHash) agg.authors.add(item.authorHash);
      agg.buckets.set(bucket, (agg.buckets.get(bucket) ?? 0) + 1);
    }
  }

  return bySymbol;
}

interface PriceWindow {
  startPrice: number | null;
  latestPrice: number | null;
  provider: string | null;
}

/**
 * The first and last PUBLICLY QUOTABLE prices in the window, for every symbol at
 * once.
 *
 * Batched deliberately: a query per symbol (times four scope/period runs)
 * exhausts the connection pooler. Two queries — a grouped min/max, then the rows
 * at those instants — do the same work at constant connection cost.
 *
 * Both ends are filtered to observations at least the public delay old, so
 * neither the opening nor the latest figure can reveal the current market.
 */
async function priceWindows(
  symbols: string[],
  start: Date,
  cutoff: Date,
): Promise<Map<string, PriceWindow>> {
  const out = new Map<string, PriceWindow>();
  if (symbols.length === 0) return out;

  const where = {
    symbol: { in: symbols },
    observedAt: { gte: start, lte: cutoff },
    price: { not: null },
  };

  const bounds = await prisma.marketQuoteSnapshots.groupBy({
    by: ["symbol"],
    where,
    _min: { observedAt: true },
    _max: { observedAt: true },
  });
  if (bounds.length === 0) return out;

  const instants = bounds.flatMap((b) =>
    [b._min.observedAt, b._max.observedAt].filter((d): d is Date => Boolean(d)),
  );
  const rows = await prisma.marketQuoteSnapshots.findMany({
    where: { symbol: { in: symbols }, observedAt: { in: instants } },
    select: { symbol: true, price: true, provider: true, observedAt: true },
  });

  const at = new Map<string, { price: number | null; provider: string | null }>();
  for (const r of rows) {
    at.set(`${r.symbol}|${r.observedAt?.toISOString()}`, {
      price: num(r.price),
      provider: r.provider,
    });
  }

  for (const b of bounds) {
    const first = at.get(`${b.symbol}|${b._min.observedAt?.toISOString()}`);
    const last = at.get(`${b.symbol}|${b._max.observedAt?.toISOString()}`);
    out.set(b.symbol, {
      startPrice: first?.price ?? null,
      latestPrice: last?.price ?? null,
      provider: last?.provider ?? first?.provider ?? null,
    });
  }

  return out;
}

async function buildScope(
  scope: ArenaScope,
  period: ArenaPeriod,
  now: Date,
  snapshotAt: string,
): Promise<{ rows: number; symbols: string[] }> {
  const { start, end } = periodBounds(period, now);
  const subreddits = scope === "wallstreetbets" ? ["wallstreetbets"] : ARENA_ALL_SUBREDDITS;
  // Daily gets hourly buckets, monthly gets daily ones — enough points to show
  // a shape without turning the sparkline into noise.
  const bucketMs = period === "daily" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  const items = await readItems(start.toISOString(), subreddits);
  const bySymbol = aggregate(items, bucketMs);
  if (bySymbol.size === 0) return { rows: 0, symbols: [] };

  const totalMentions = [...bySymbol.values()].reduce((s, a) => s + a.mentions, 0);

  const top = [...bySymbol.values()]
    .sort(
      (a, b) =>
        b.mentions - a.mentions ||
        // Tie-breaks: broader reach first, then more distinct voices, then
        // alphabetical so the order is stable across runs.
        b.subreddits.size - a.subreddits.size ||
        b.authors.size - a.authors.size ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, TOP_N);

  const cutoff = publicPriceCutoff(now);
  const providerSocial = items.length > 0 ? "mindcase" : null;
  const windows = await priceWindows(
    top.map((a) => a.symbol),
    start,
    cutoff,
  );

  const data = top.map((agg, index) => {
      const { startPrice, latestPrice, provider } = windows.get(agg.symbol) ?? {
        startPrice: null,
        latestPrice: null,
        provider: null,
      };
      const classified = agg.bullish + agg.neutral + agg.bearish;
      const performancePct =
        startPrice !== null && latestPrice !== null && startPrice > 0
          ? Math.round(((latestPrice - startPrice) / startPrice) * 10000) / 100
          : null;

      return {
        scope,
        period,
        periodStart: start,
        periodEnd: end,
        symbol: agg.symbol,
        rank: index + 1,
        mentions: agg.mentions,
        mentionSharePct: pct(agg.mentions, totalMentions),
        subredditCount: agg.subreddits.size,
        // Percentages are of CLASSIFIED items — an unread stance is not neutral.
        bullishPct: classified > 0 ? pct(agg.bullish, classified) : null,
        neutralPct: classified > 0 ? pct(agg.neutral, classified) : null,
        bearishPct: classified > 0 ? pct(agg.bearish, classified) : null,
        classifiedCount: classified,
        startPrice,
        latestPrice,
        performancePct,
        trend: [...agg.buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([ts, mentions]) => ({ timestamp: new Date(ts).toISOString(), mentions })),
        providerSocial,
        providerMarket: provider,
        displayMode: "delayed",
        delayMinutes: PUBLIC_DELAY_MINUTES,
        isMock: false,
        snapshotAt,
      };
  });

  await prisma.arenaTickerPerformanceSnapshots.createMany({ data });
  return { rows: data.length, symbols: data.map((d) => d.symbol) };
}

export async function refreshArenaTickerPerformance(): Promise<JobMetadata> {
  const now = new Date();
  const snapshotAt = now.toISOString();
  const result: Record<string, unknown> = {};
  let wrote = 0;

  for (const scope of ARENA_SCOPES) {
    for (const period of ARENA_PERIODS) {
      const { rows, symbols } = await buildScope(scope, period, now, snapshotAt);
      result[`${scope}:${period}`] = { rows, symbols };
      wrote += rows;
    }
  }

  if (wrote === 0) {
    // Leaves the previous snapshot in place for the API to keep serving.
    throw new Error(
      "No Arena ticker rows written — no stored social content in any period; previous snapshots kept.",
    );
  }

  return { snapshotAt, rowsWritten: wrote, perScope: result };
}

// Manual run: npm run arena:tickers:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshArenaTickerPerformance", refreshArenaTickerPerformance);
}
