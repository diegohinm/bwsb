import { isMainModule, runJobAsScript } from "../lib/jobRunner.js";
import { resolveDueYoloBets } from "../services/arena/betResolution.service.js";
import { scoreUnscoredBanbets } from "../services/arena/banbetScoring.service.js";
import { ingestBanbetsFromBot } from "../services/arena/banbetIngest.service.js";

/**
 * WORKER JOB — settle the Arena.
 *
 * Two phases, both read-only against the outside world:
 *
 *   1. RESOLVE YOLOPULSE BETS against stored candles. Touch, not close: a
 *      target reached intraday and given back by the bell still won.
 *   0. CONFIRM BANBETS from the WSB bot's own "BanBet Created/Won/Lost"
 *      messages, which are already in `social_comments`. A bare !banbet
 *      comment is a candidate; the bot's reply is what makes it a record.
 *   2. SCORE CONFIRMED BANBETS that resolved without a score, reconstructing
 *      the entry price and volatility from bars strictly BEFORE the call was
 *      made.
 *
 * Calls no provider. Everything comes from `market_candles`, which the
 * market-data worker fills, so the Arena cannot cost an upstream request no
 * matter how often it runs — and a gap in those bars leaves a bet unresolved
 * rather than resolving it wrongly.
 *
 * Idempotent by construction: phase 1 only touches `active` rows and phase 2
 * only rows with a NULL `scoring_version`, so a re-run after a crash neither
 * double-counts nor rescores settled history.
 */

export async function resolveYoloBetsJob() {
  // Confirmations first: a banbet is a record only once the WSB bot has
  // published it, and the scorer below only touches confirmed rows.
  const ingested = await ingestBanbetsFromBot();
  const resolved = await resolveDueYoloBets();
  const scored = await scoreUnscoredBanbets();

  return {
    banbetIngest: ingested,
    yoloBets: resolved,
    banbets: scored,
    // Surfaced rather than swallowed: bets whose window has passed but whose
    // bars never arrived are a DATA gap, and a silent zero here would look
    // exactly like a quiet week.
    unresolvableForMissingBars: resolved.unresolvable,
    banbetsUnscoredForMissingHistory:
      scored.skippedNoEntryPrice + scored.skippedNoVolatility,
  };
}

// Manual run: npm run arena:resolve
if (isMainModule(import.meta.url)) {
  void runJobAsScript("resolveYoloBets", resolveYoloBetsJob);
}
