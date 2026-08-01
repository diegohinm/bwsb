import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { readSocialItems } from "../repositories/socialSnapshots.repository.js";
import {
  readLastQuotes,
  saveWsbPortfolioSnapshot,
} from "../repositories/wsbPortfolio.repository.js";
import { extractPositionsFromItems } from "../services/wsb/positionExtractor.service.js";
import { buildPortfolio } from "../services/wsb/wsbPortfolioAggregator.service.js";
import {
  WSB_TIMEFRAMES,
  WSB_TIMEFRAME_MS,
  type WsbTimeframe,
} from "../services/wsb/wsb.types.js";

/**
 * WORKER JOB — WSB portfolio snapshots.
 *
 * Reads content the social ingestion job ALREADY stored, extracts declared
 * positions from it, aggregates them and writes one snapshot per timeframe.
 *
 * It calls no provider. That is deliberate and structural: this job is pure
 * derivation over `social_posts` / `social_comments`, so it can run as often as
 * we like without touching a rate limit, and a Mindcase outage degrades it only
 * as far as the underlying content is stale.
 *
 * Failure semantics match the pulse job: a timeframe that produces nothing
 * writes nothing, leaving the previous snapshot in place for the API to serve.
 * The run only throws when EVERY timeframe came up empty, so one quiet window
 * never discards the others.
 */

/** Cap on items pulled per window — one huge window can't blow up memory. */
const MAX_ITEMS = 5_000;

export async function refreshWsbPortfolio(): Promise<JobMetadata> {
  // One clock for the whole run: every timeframe classifies DTE against the
  // same instant, so two snapshots taken by one run cannot disagree on a bucket.
  const now = new Date();
  const snapshotAt = now.toISOString();

  const perTimeframe: Record<string, unknown> = {};
  let wrote = 0;

  for (const timeframe of WSB_TIMEFRAMES as readonly WsbTimeframe[]) {
    const sinceIso = new Date(now.getTime() - WSB_TIMEFRAME_MS[timeframe]).toISOString();
    const items = await readSocialItems({ sinceIso, limit: MAX_ITEMS });

    if (items.length === 0) {
      perTimeframe[timeframe] = { items: 0, skipped: "no stored social content" };
      continue;
    }

    const positions = extractPositionsFromItems(items, now);
    if (positions.length === 0) {
      // Content exists but nobody declared a position in it. Writing an
      // all-zero snapshot would replace a good one with an empty portfolio.
      perTimeframe[timeframe] = { items: items.length, positions: 0, skipped: "no positions extracted" };
      continue;
    }

    // Value stock holdings with quotes we already hold; symbols we have no
    // quote for stay null rather than being priced by guesswork.
    const symbols = [
      ...new Set(positions.filter((p) => p.kind === "stock").map((p) => p.ticker)),
    ];
    const prices = await readLastQuotes(symbols);

    const aggregate = buildPortfolio(positions, prices);
    // Provenance is inherited from the content the positions came from — the
    // portfolio is exactly as real as its source material.
    const provider = items[0]?.provider ?? "mock";
    const isMock = items.every((i) => i.provider === "mock");

    const written = await saveWsbPortfolioSnapshot(
      {
        timeframe,
        provider,
        source: items[0]?.source ?? provider,
        isMock,
        warning: null,
        summary: aggregate.summary,
        options: aggregate.options,
        stocks: aggregate.stocks,
      },
      snapshotAt,
    );

    wrote += 1;
    perTimeframe[timeframe] = {
      items: items.length,
      positions: positions.length,
      traders: aggregate.summary.traders,
      optionRows: written.options,
      stockRows: written.stocks,
      totalExposure: aggregate.summary.totalExposure,
      isMock,
    };
  }

  if (wrote === 0) {
    throw new Error(
      "No WSB portfolio snapshot written for any timeframe (no stored social content or no extractable positions); previous snapshots kept.",
    );
  }

  return { snapshotAt, timeframesWritten: wrote, perTimeframe };
}

// Manual run: npm run wsb:portfolio:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshWsbPortfolio", refreshWsbPortfolio);
}
