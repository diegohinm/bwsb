import { WORKER_PULSE_TIMEFRAMES } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import {
  readSocialItems,
  savePulseSnapshot,
} from "../repositories/socialSnapshots.repository.js";
import { buildSubredditPulse } from "../services/social/pulseAggregator.service.js";
import { redditConfig } from "../config/reddit.config.js";
import type { PulseTimeframe } from "../services/social/socialData.types.js";

/**
 * WORKER JOB — subreddit pulse aggregation. DATABASE ONLY.
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED. This job WAS the ingestion path: it
 * swept every entry in `REDDIT_SUBREDDITS` through Mindcase, stored the items,
 * then aggregated them. With five communities configured and 50 rows requested
 * each, every run bought 250 billable rows — and it ran every ten minutes. That
 * is ~36,000 rows/day, roughly $180/day at $0.005 a row, for content of which
 * only wallstreetbets was ever displayed.
 *
 * It was also the source of the "5 runs × 50 rows" pattern in the run history:
 * five subreddits, one agent job each, one cycle.
 *
 * FETCHING NOW BELONGS TO jobs/syncRedditPosts + jobs/syncRedditComments, which
 * are incremental, WSB-only, market-aware and budget-guarded. What remains here
 * is the part that was always free: turning stored rows into pulse snapshots.
 *
 * So this job now calls NO PROVIDER AT ALL. It can run as often as we like, it
 * cannot fail because of a rate limit, and a Mindcase outage degrades it only in
 * the sense that the newest rows are missing.
 */

/** How far back each pulse timeframe looks. The widest one sizes the read. */
const TIMEFRAME_HOURS: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 24 * 7 };

export async function refreshSocialPulse(): Promise<JobMetadata> {
  // The communities to REPORT on: every tracked one, not just the ingested one.
  // Aggregating stored rows costs nothing per community, so narrowing this would
  // throw away history for no saving — the multi-community surfaces keep working
  // on whatever has been collected, by this provider or by Arctic Shift.
  const subreddits = [...redditConfig.subreddits];

  // The widest timeframe decides how far back to read; the narrower ones are
  // computed from the same rows rather than re-queried.
  const lookbackHours = Math.max(
    ...WORKER_PULSE_TIMEFRAMES.map((tf) => TIMEFRAME_HOURS[tf] ?? 24),
  );
  const sinceIso = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();

  const items = await readSocialItems({ sinceIso, subreddits, limit: 20_000 });

  if (items.length === 0) {
    // An empty window is not an outage now that nothing is fetched: it means
    // the sync jobs have not stored anything recent. Previous snapshots stay.
    return {
      status: "success_without_change",
      reason: "no stored social items in the pulse window",
      subredditsAttempted: subreddits.length,
    };
  }

  const snapshotAt = new Date().toISOString();
  // Provenance comes from the rows themselves now. There is no sweep to have
  // partially failed, so there is no partial-data warning to raise either — a
  // community with nothing stored simply contributes nothing.
  const providerName = items[0]?.provider ?? "mock";
  const isMock = items.every((i) => i.provider === "mock");
  const warning = null;

  const perTimeframe: Record<string, number> = {};
  for (const timeframe of WORKER_PULSE_TIMEFRAMES as readonly PulseTimeframe[]) {
    const aggregate = buildSubredditPulse(items, timeframe);
    perTimeframe[timeframe] = await savePulseSnapshot(
      {
        timeframe,
        provider: providerName,
        source: providerName,
        isMock,
        warning,
        subreddits: aggregate.subreddits,
      },
      snapshotAt,
    );
  }

  return {
    provider: providerName,
    snapshotAt,
    // AGGREGATED, not fetched. Zero provider requests, zero cost.
    itemsAggregated: items.length,
    subredditsAttempted: subreddits.length,
    pulseRowsPerTimeframe: perTimeframe,
    isMock,
  };
}

// Manual run: npm run social:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshSocialPulse", refreshSocialPulse);
}
