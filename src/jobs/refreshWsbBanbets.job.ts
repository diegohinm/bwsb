import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import { readSocialItems } from "../repositories/socialSnapshots.repository.js";
import { readLastQuotes } from "../repositories/wsbPortfolio.repository.js";
import { upsertBanbets, expireDueBanbets } from "../repositories/wsbBanbets.repository.js";
import { extractBanbetsFromItems, resolveOutcome } from "../services/wsb/banbetExtractor.service.js";
import type { BanbetOperator } from "../services/wsb/wsb.types.js";

/**
 * WORKER JOB — WSB banbets.
 *
 * Three phases, in order:
 *
 *   1. INGEST   parse falsifiable price calls out of already-stored social
 *               content and upsert them as `open` bets.
 *   2. RESOLVE  for bets whose deadline has passed, compare the last known
 *               quote against the target and mark won/lost.
 *   3. EXPIRE   anything still open past its deadline with no usable price is
 *               `expired` — never "lost". A missing price is our gap, not the
 *               bettor's loss.
 *
 * Like the portfolio job this calls no provider: it derives from stored content
 * and stored quotes, so it cannot trigger ingestion or hit a rate limit.
 *
 * Upserts are keyed by `external_id`, so re-running over an overlapping window
 * updates rather than duplicates.
 */

/** Window of stored content scanned for new calls each run. */
const INGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 5_000;
/** Bets resolved per run — bounded so one run can't hold a long transaction. */
const RESOLVE_BATCH = 500;

export async function refreshWsbBanbets(): Promise<JobMetadata> {
  const now = new Date();

  // ── 1. Ingest ──────────────────────────────────────────────────────────────
  const items = await readSocialItems({
    sinceIso: new Date(now.getTime() - INGEST_WINDOW_MS).toISOString(),
    limit: MAX_ITEMS,
  });

  const extracted = extractBanbetsFromItems(items);
  const provider = items[0]?.provider ?? "mock";
  const isMock = items.length > 0 && items.every((i) => i.provider === "mock");

  const ingested = extracted.length
    ? await upsertBanbets(
        extracted.map((b) => ({
          externalId: b.externalId,
          usernameHash: b.usernameHash,
          // The pipeline only ever holds an anonymized author, so no Reddit
          // handle is stored — the UI renders an anonymous label.
          displayUsername: null,
          ticker: b.ticker,
          operator: b.operator,
          targetPrice: b.targetPrice,
          side: b.side,
          status: "open" as const,
          resultPct: null,
          sourceUrl: b.sourceUrl,
          subreddit: b.subreddit,
          createdAt: b.createdAt.toISOString(),
          expiresAt: b.expiresAt.toISOString(),
          resolvedAt: null,
          provider,
          source: items[0]?.source ?? provider,
          isMock,
        })),
      )
    : 0;

  // ── 2. Resolve ─────────────────────────────────────────────────────────────
  const due = await prisma.wsbBanbets.findMany({
    where: { status: "open", expiresAt: { lt: now } },
    take: RESOLVE_BATCH,
    select: { id: true, ticker: true, operator: true, targetPrice: true },
  });

  const quotes = await readLastQuotes([...new Set(due.map((b) => b.ticker))]);
  let won = 0;
  let lost = 0;

  for (const bet of due) {
    const outcome = resolveOutcome(
      { operator: bet.operator as BanbetOperator, targetPrice: num(bet.targetPrice) ?? 0 },
      quotes.get(bet.ticker) ?? null,
    );
    if (!outcome) continue; // no price — phase 3 expires it

    await prisma.wsbBanbets.update({
      where: { id: bet.id },
      data: { status: outcome.status, resultPct: outcome.resultPct, resolvedAt: now },
    });
    if (outcome.status === "won") won += 1;
    else lost += 1;
  }

  // ── 3. Expire ──────────────────────────────────────────────────────────────
  const expired = await expireDueBanbets(now);

  return {
    itemsScanned: items.length,
    extracted: extracted.length,
    ingested,
    dueForResolution: due.length,
    resolvedWon: won,
    resolvedLost: lost,
    expired,
    isMock,
  };
}

// Manual run: npm run wsb:banbets:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshWsbBanbets", refreshWsbBanbets);
}
