import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { prisma } from "../lib/prisma.js";
import {
  BUCKET_MS,
  BUCKET_SIZES,
  replaceBuckets,
  type BucketSize,
} from "../repositories/tickerSocialMetrics.repository.js";

/**
 * WORKER JOB — per-ticker social metrics.
 *
 * Buckets the stored social content into mention and stance counts per ticker,
 * so the API can serve the Feel % column and the mentions-trend chart from a
 * small aggregate instead of scanning `social_posts` / `social_comments` on
 * every page load.
 *
 * It calls no provider: pure derivation over rows the ingestion job already
 * wrote. That is what makes toggling a ticker on the chart a database read and
 * never an upstream request.
 *
 * Classification honesty: `mentions` counts every item referencing the ticker,
 * while the stance counts only include items the classifier actually labelled.
 * An item with no stance is left out of the denominator rather than being filed
 * as neutral — the UI would otherwise report an opinion nobody expressed.
 */

/** How far back each bucket size is recomputed — one UI window's worth. */
const WINDOW_MS: Record<BucketSize, number> = {
  "5m": 60 * 60 * 1000, // 1H
  "30m": 6 * 60 * 60 * 1000, // 6H
  "1h": 24 * 60 * 60 * 1000, // 24H
  "6h": 7 * 24 * 60 * 60 * 1000, // 7D
};

const STANCES = new Set(["bullish", "neutral", "bearish"]);

/** Rows of the two content tables, reduced to what the aggregation needs. */
type Item = { postedAt: Date | null; tickers: string[]; stance: string | null };

function floorTo(date: Date, sizeMs: number): Date {
  return new Date(Math.floor(date.getTime() / sizeMs) * sizeMs);
}

async function readItems(sinceIso: string): Promise<Item[]> {
  const where = { postedAt: { gte: new Date(sinceIso) } };
  const select = { postedAt: true, tickers: true, stance: true } as const;
  const [posts, comments] = await Promise.all([
    prisma.socialPosts.findMany({ where, select }),
    prisma.socialComments.findMany({ where, select }),
  ]);
  return [...posts, ...comments];
}

/** Group items into (ticker, bucket) counts for one bucket size. */
function bucketize(items: Item[], sizeMs: number) {
  const acc = new Map<
    string,
    { ticker: string; bucketStart: Date; mentions: number; bullishCount: number; neutralCount: number; bearishCount: number }
  >();

  for (const item of items) {
    if (!item.postedAt) continue;
    const bucketStart = floorTo(item.postedAt, sizeMs);
    const stance = item.stance && STANCES.has(item.stance) ? item.stance : null;

    // De-dupe within one item so a post naming NVDA twice counts once.
    for (const raw of new Set(item.tickers ?? [])) {
      const ticker = raw.toUpperCase();
      const key = `${ticker}|${bucketStart.getTime()}`;
      let row = acc.get(key);
      if (!row) {
        row = {
          ticker,
          bucketStart,
          mentions: 0,
          bullishCount: 0,
          neutralCount: 0,
          bearishCount: 0,
        };
        acc.set(key, row);
      }
      row.mentions += 1;
      if (stance === "bullish") row.bullishCount += 1;
      else if (stance === "bearish") row.bearishCount += 1;
      else if (stance === "neutral") row.neutralCount += 1;
    }
  }

  return [...acc.values()];
}

export async function refreshTickerSocialMetrics(): Promise<JobMetadata> {
  const now = Date.now();
  // One read of the widest window feeds every bucket size — re-reading per size
  // would be four scans of the same rows.
  const widest = Math.max(...Object.values(WINDOW_MS));
  const items = await readItems(new Date(now - widest).toISOString());

  if (items.length === 0) {
    throw new Error(
      "No stored social content in the 7d window; ticker social metrics left untouched.",
    );
  }

  // Provenance follows the content the metrics were derived from.
  const sample = await prisma.socialPosts.findFirst({
    where: { postedAt: { gte: new Date(now - widest) } },
    orderBy: { postedAt: "desc" },
    select: { provider: true, source: true },
  });
  const provider = sample?.provider ?? "mock";
  const meta = {
    provider,
    source: sample?.source ?? provider,
    isMock: provider === "mock",
  };

  const perBucket: Record<string, number> = {};
  for (const size of BUCKET_SIZES) {
    const fromIso = new Date(now - WINDOW_MS[size]).toISOString();
    const scoped = items.filter(
      (i) => i.postedAt && i.postedAt.getTime() >= now - WINDOW_MS[size],
    );
    const rows = bucketize(scoped, BUCKET_MS[size]);
    perBucket[size] = await replaceBuckets(size, fromIso, rows, meta);
  }

  return {
    itemsScanned: items.length,
    rowsPerBucketSize: perBucket,
    provider,
    isMock: meta.isMock,
  };
}

// Manual run: npm run ticker:metrics:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshTickerSocialMetrics", refreshTickerSocialMetrics);
}
