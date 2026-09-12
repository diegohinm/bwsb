import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE MAIN DESIGN RULE, ENFORCED RATHER THAN DOCUMENTED.
 *
 *   Reddit analytics must work with Databento OFFLINE.
 *   Databento ENRICHES YOLOPulse. It does not POWER YOLOPulse's Reddit surfaces.
 *
 * This walks the actual import graph from each Reddit read path and asserts it
 * never reaches a market-data provider or a Reddit upstream. It reads source
 * rather than exercising behaviour because the failure it guards against is
 * invisible until the day the provider is down: an import added to serve one
 * price on one panel works perfectly in every test and every staging
 * environment, and takes Discussion down with Databento the first time
 * Databento breaks.
 *
 * It is also the check that keeps the OTHER forbidden shape out:
 *
 *     reddit item → ticker detected → Databento → save
 *
 * Nothing on the ingestion write path may import the provider layer either, so
 * a Reddit item can never be waiting on a market request to be stored.
 *
 * WHEN THIS FAILS, the fix is almost never to add an entry to the allowed list.
 * It is to move the market read into its own endpoint the client calls
 * separately — which is what "Reddit endpoints must not call market endpoints
 * internally" means in practice.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Relative import specifiers, which is all this codebase uses internally. */
const IMPORT = /(?:import|export)[\s\S]*?from\s*"(\.[^"]+)"/g;

function readSource(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Resolve a ".js" specifier back to the ".ts" file it was written as. */
function resolveModule(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (readSource(candidate) !== null) return candidate;
  }
  return null;
}

/** Every module reachable from an entry point, by relative import. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: { file: string; path: string[] }[] = [{ file: entry, path: [] }];

  while (queue.length > 0) {
    const { file, path } = queue.shift()!;
    const key = relative(SRC, file).replace(/\\/g, "/");
    if (seen.has(key)) continue;
    seen.set(key, path);

    const text = readSource(file);
    if (text === null) continue;

    IMPORT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT.exec(text)) !== null) {
      const target = resolveModule(file, match[1]);
      if (target) queue.push({ file: target, path: [...path, key] });
    }
  }

  return seen;
}

/**
 * Modules that talk to something outside this process.
 *
 * The PROVIDERS, not the services that wrap them: `marketRead.service` is
 * database-only by design and is perfectly fine for a Reddit surface to depend
 * on, whereas anything that can produce an HTTP request to Databento or
 * Mindcase is not.
 */
const UPSTREAM = [
  "services/market-data/providers/databentoMarketData.provider.ts",
  "services/market-data/providers/polygonMarketData.provider.ts",
  "services/market-data/providers/alpacaMarketData.provider.ts",
  "services/market-data/providers/twelveDataMarketData.provider.ts",
  "services/market-data/marketDataProvider.factory.ts",
  "services/market-data/marketData.service.ts",
  "providers/reddit/MindcaseProvider.ts",
  "providers/reddit/RedditProviderFactory.ts",
  "providers/reddit/mindcaseRedditRequest.ts",
  "services/social/providers/mindcaseSocialData.provider.ts",
  "services/social/socialDataProvider.factory.ts",
];

/**
 * The surfaces named in the requirement: Discussion Results, Discussion Summary,
 * search, Top Tickers, Hot Tickers, sentiment, mentions and Daily Discussion.
 *
 * All eight are served by these three modules plus the live feed's source.
 */
const REDDIT_READ_PATHS = [
  "services/discussion/discussionRead.service.ts",
  "services/discussion/discussionSummary.service.ts",
  "services/discussion/searchQuery.ts",
  "services/social/dailyDiscussion.service.ts",
  "realtime/discussionSource.ts",
];

/** The write path: storing a Reddit item must not depend on a market call. */
const REDDIT_WRITE_PATHS = [
  "repositories/socialSnapshots.repository.ts",
  "repositories/tickerAssociations.repository.ts",
  "services/social/tickerActivity.service.ts",
  "services/extraction/tickerExtraction.service.ts",
];

/**
 * The Mindcase ingestion pair. These DO reach Mindcase — that is their job —
 * but they must never reach Databento: a market-data outage has no business
 * stopping Reddit from being collected, and the ingestion cadence must not
 * depend on asking a paid market provider whether the market is open.
 */
const REDDIT_INGESTION_PATHS = [
  "jobs/syncRedditPosts.job.ts",
  "jobs/syncRedditComments.job.ts",
  "services/reddit/redditSync.service.ts",
  "services/reddit/redditSyncPlan.ts",
  "services/market/usMarketCalendar.ts",
];

const MARKET_UPSTREAM = UPSTREAM.filter((m) => m.startsWith("services/market-data/"));

function assertNoUpstream(entry: string): void {
  const reachable = reachableFrom(resolve(SRC, entry));

  for (const upstream of UPSTREAM) {
    const path = reachable.get(upstream);
    if (path === undefined) continue;

    assert.fail(
      `${entry} can reach ${upstream}.\n` +
        `  via: ${[...path, upstream].join("\n     → ")}\n` +
        `  A Reddit surface that imports a provider stops working when that ` +
        `provider does. Serve the market data from its own endpoint instead.`,
    );
  }
}

describe("Reddit read paths never reach a provider", () => {
  for (const entry of REDDIT_READ_PATHS) {
    it(`${entry} works with every upstream offline`, () => assertNoUpstream(entry));
  }
});

describe("Reddit ingestion never waits on market data", () => {
  for (const entry of REDDIT_WRITE_PATHS) {
    it(`${entry} stores content without a market call`, () => assertNoUpstream(entry));
  }
});

describe("Reddit ingestion never depends on a market provider", () => {
  for (const entry of REDDIT_INGESTION_PATHS) {
    it(`${entry} works with Databento offline`, () => {
      const reachable = reachableFrom(resolve(SRC, entry));
      for (const upstream of MARKET_UPSTREAM) {
        const path = reachable.get(upstream);
        if (path === undefined) continue;
        assert.fail(
          `${entry} can reach ${upstream}.\n` +
            `  via: ${[...path, upstream].join("\n     → ")}\n` +
            `  Reddit ingestion must not be able to stall on a market provider — ` +
            `least of all to ask whether the market is open, which is what ` +
            `services/market/usMarketCalendar.ts answers locally.`,
        );
      }
    });
  }
});

describe("the market pipeline is the only thing that fetches market data", () => {
  it("keeps the market worker clear of Reddit ingestion", () => {
    const reachable = reachableFrom(resolve(SRC, "workers/market/databentoWorker.ts"));

    // The market worker may read `ticker_activity` through the priority service,
    // but it must never pull in the Reddit INGESTION path — that is the
    // direction that would let a Databento outage stall Reddit writes.
    for (const forbidden of [
      "services/redditIngestionService.ts",
      "repositories/socialSnapshots.repository.ts",
      "providers/reddit/RedditProviderFactory.ts",
    ]) {
      assert.equal(
        reachable.has(forbidden),
        false,
        `the market worker must not import ${forbidden}`,
      );
    }
  });
});
