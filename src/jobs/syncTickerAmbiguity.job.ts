import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { prisma } from "../lib/prisma.js";
import {
  MANUAL_AMBIGUOUS_TICKERS,
  isAmbiguousTicker,
} from "../config/tickers/ambiguousTickers.js";
import { mapWithConcurrency } from "../lib/concurrency.js";

/**
 * Bring `tickers.is_ambiguous` in line with the current rule, immediately.
 *
 * The daily catalog refresh already computes this on every import, so the value
 * would become correct eventually. This exists because "eventually" is a day
 * away and the rule changes when someone edits a config file — waiting for a
 * refresh means the detector and the catalog disagree until then, and a refresh
 * that fails extends the gap indefinitely.
 *
 * Run as `npm run ticker-catalog:sync-ambiguity`.
 *
 * IDEMPOTENT. It computes the desired value for every active symbol and writes
 * only the rows that differ, so a second run reports zero changes. Nothing is
 * ever deleted and no symbol is removed from the catalog: an ambiguous ticker is
 * still a real security, and `$CAR` still resolves.
 */

const JOB_NAME = "syncTickerAmbiguity";
const LOG = "[ticker-ambiguity]";

/** Rows per UPDATE. Two statements per direction is plenty for ~15k symbols. */
const BATCH_SIZE = 1_000;

export type AmbiguitySyncResult = {
  scanned: number;
  flagged: number;
  unflagged: number;
  singleLetterAmbiguous: number;
  manualAmbiguous: number;
  totalAmbiguous: number;
};

export async function syncTickerAmbiguity(): Promise<JobMetadata> {
  const symbols = await prisma.tickers.findMany({
    select: { ticker: true, isAmbiguous: true },
  });

  // Decided in TypeScript, from the one config file, rather than duplicated as
  // a SQL predicate — a second copy of the rule is a second thing to keep in
  // step, and the migration that seeded this column is already one.
  const shouldFlag: string[] = [];
  const shouldClear: string[] = [];
  for (const row of symbols) {
    const desired = isAmbiguousTicker(row.ticker);
    if (desired && !row.isAmbiguous) shouldFlag.push(row.ticker);
    // Clearing matters: a symbol removed from the manual list must lose the
    // flag, otherwise the config can only ever grow in effect.
    else if (!desired && row.isAmbiguous) shouldClear.push(row.ticker);
  }

  const chunks = <T,>(list: T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += BATCH_SIZE) out.push(list.slice(i, i + BATCH_SIZE));
    return out;
  };

  await mapWithConcurrency(chunks(shouldFlag), (batch) =>
    prisma.tickers.updateMany({ where: { ticker: { in: batch } }, data: { isAmbiguous: true } }),
  );
  await mapWithConcurrency(chunks(shouldClear), (batch) =>
    prisma.tickers.updateMany({ where: { ticker: { in: batch } }, data: { isAmbiguous: false } }),
  );

  const [singleLetter, manual, total] = await Promise.all([
    prisma.tickers.count({ where: { isAmbiguous: true, ticker: { in: oneCharSymbols(symbols) } } }),
    prisma.tickers.count({
      where: { isAmbiguous: true, ticker: { in: [...MANUAL_AMBIGUOUS_TICKERS] } },
    }),
    prisma.tickers.count({ where: { isAmbiguous: true } }),
  ]);

  const result: AmbiguitySyncResult = {
    scanned: symbols.length,
    flagged: shouldFlag.length,
    unflagged: shouldClear.length,
    singleLetterAmbiguous: singleLetter,
    manualAmbiguous: manual,
    totalAmbiguous: total,
  };

  console.log(
    `${LOG} scanned=${result.scanned} flagged=${result.flagged} unflagged=${result.unflagged} ` +
      `singleLetter=${result.singleLetterAmbiguous} manual=${result.manualAmbiguous} ` +
      `total=${result.totalAmbiguous}`,
  );

  return { ...result };
}

function oneCharSymbols(rows: { ticker: string }[]): string[] {
  return rows.map((r) => r.ticker).filter((t) => t.length === 1);
}

// Guarded: importing this module must not rewrite the catalog.
if (isMainModule(import.meta.url)) {
  void runJobAsScript(JOB_NAME, syncTickerAmbiguity);
}
