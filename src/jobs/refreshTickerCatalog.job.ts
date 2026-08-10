import { env } from "../config/env.js";
import { isAmbiguousTicker } from "../config/tickers/ambiguousTickers.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import { prisma } from "../lib/prisma.js";
import { downloadText } from "../services/tickerCatalog/download.js";
import {
  mergeBySymbol,
  planSourceReconciliation,
  type ExistingRow,
} from "../services/tickerCatalog/reconcile.js";
import { parseCboeIndexes } from "../services/tickerCatalog/sources/cboeIndexes.source.js";
import { parseNasdaqListed } from "../services/tickerCatalog/sources/nasdaqListed.source.js";
import { parseOtherListed } from "../services/tickerCatalog/sources/otherListed.source.js";
import {
  SOURCE_IDS,
  type NormalizedTickerRecord,
  type SourceId,
  type SourceParseResult,
} from "../services/tickerCatalog/types.js";

/**
 * WORKER JOB — refresh the ticker catalog from every enabled source.
 *
 * Three independent directories feed one table:
 *
 *   Nasdaq Trader · nasdaqlisted.txt   Nasdaq equities and ETFs
 *   Nasdaq Trader · otherlisted.txt    NYSE, NYSE American, NYSE Arca, Cboe BZX, IEX
 *   Cboe          · index definitions  SPX, VIX, RUT and the rest
 *
 * Runs once a day. The catalog is slowly-changing reference data.
 *
 * THE TWO INVARIANTS
 *
 *   1. A source that fails changes NOTHING — not its own rows, and certainly
 *      not another source's. Deactivation is the dangerous operation, and it
 *      only ever runs for a source whose payload downloaded, parsed and passed
 *      validation.
 *
 *   2. Sources are ISOLATED. Cboe returning a 500 must leave SPX active, and a
 *      Nasdaq outage must not retire the NYSE universe. Each source is fetched,
 *      parsed and applied in its own try/catch and its own transaction, and its
 *      deactivation sweep is scoped by `tickers.source`.
 *
 * The job fails only when EVERY enabled source failed; a partial failure is
 * reported as a partial success, because the sources that did work should not
 * be rolled back for the one that did not.
 *
 * NO REDDIT, NO EXTRACTION, NO AI. The inputs are three public files.
 */

const JOB_NAME = "refreshTickerCatalog";
const LOG = "[ticker-catalog]";

/**
 * Rows per statement.
 *
 * One multi-row `INSERT … ON CONFLICT` rather than ~12,000 upserts: two dozen
 * round trips instead of thousands, which matters on a three-connection pool.
 * Well under Postgres' 65,535 bound-parameter ceiling (500 × 6).
 */
const BATCH_SIZE = 500;
const TRANSACTION_TIMEOUT_MS = 180_000;
const TRANSACTION_MAX_WAIT_MS = 30_000;

export type SourceOutcome = {
  source: SourceId;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  recordsReceived: number;
  recordsAccepted: number;
  created: number;
  updated: number;
  reactivated: number;
  deactivated: number;
  unknownExchangeCodes?: Record<string, number>;
  error?: string;
};

type SourceDefinition = {
  id: SourceId;
  label: string;
  enabled: boolean;
  url: string;
  parse: (text: string) => SourceParseResult;
};

function sourceDefinitions(): SourceDefinition[] {
  return [
    {
      id: SOURCE_IDS.nasdaqListed,
      label: "NASDAQ_LISTED",
      enabled: true,
      url: env.NASDAQ_LISTED_SOURCE_URL,
      parse: parseNasdaqListed,
    },
    {
      id: SOURCE_IDS.otherListed,
      label: "OTHER_LISTED",
      enabled: true,
      url: env.OTHER_LISTED_SOURCE_URL,
      parse: parseOtherListed,
    },
    {
      id: SOURCE_IDS.cboeIndexes,
      label: "CBOE_INDEX",
      enabled: env.CBOE_INDEX_CATALOG_ENABLED,
      url: env.CBOE_INDEX_CATALOG_SOURCE_URL,
      parse: parseCboeIndexes,
    },
  ];
}

/**
 * Write one batch as a single statement.
 *
 * `is_common_word` is deliberately absent from the UPDATE list. It belongs to
 * the Reddit extractor and was curated from observed false positives; a daily
 * import must not reset it. `created_at` is likewise untouched, so a symbol
 * that leaves and returns keeps its original first-seen date.
 */
async function upsertBatch(
  tx: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> },
  batch: NormalizedTickerRecord[],
  seenAt: Date,
): Promise<void> {
  const values: unknown[] = [];
  const tuples = batch.map((record, i) => {
    const base = i * 6;
    values.push(
      record.symbol,
      record.companyName,
      record.exchange,
      record.securityType,
      record.source,
      // YOLOPulse metadata, not the source's — see config/tickers.
      isAmbiguousTicker(record.symbol),
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${batch.length * 6 + 1}::timestamptz, true, now())`;
  });
  values.push(seenAt);

  await tx.$executeRawUnsafe(
    `INSERT INTO "tickers"
       ("ticker", "company_name", "exchange", "security_type", "source",
        "is_ambiguous", "last_seen_at", "is_active", "updated_at")
     VALUES ${tuples.join(", ")}
     ON CONFLICT ("ticker") DO UPDATE SET
       "company_name"  = EXCLUDED."company_name",
       "exchange"      = EXCLUDED."exchange",
       "security_type" = EXCLUDED."security_type",
       "source"        = EXCLUDED."source",
       "is_ambiguous"  = EXCLUDED."is_ambiguous",
       "last_seen_at"  = EXCLUDED."last_seen_at",
       "is_active"     = true,
       "updated_at"    = now()`,
    ...values,
  );
}

/**
 * Apply one source's validated records. Its own transaction, its own scope.
 *
 * `records` is the source's WINNING subset after the cross-source merge, so a
 * symbol is written exactly once no matter how many directories claim it.
 * `ownedSymbols` is the source's COMPLETE validated dataset, which is what
 * deactivation must be judged against — a symbol the source still lists has not
 * left its universe just because another directory won the right to describe it.
 */
async function applySource(
  definition: SourceDefinition,
  records: NormalizedTickerRecord[],
  ownedSymbols: readonly string[],
  seenAt: Date,
): Promise<Pick<SourceOutcome, "created" | "updated" | "reactivated" | "deactivated">> {
  const symbols = records.map((r) => r.symbol);

  return prisma.$transaction(
    async (tx) => {
      // Everything this source could affect: the rows it owns, plus any row
      // matching a symbol it is supplying (which may currently be owned by
      // another source, or by none).
      const existing = await tx.tickers.findMany({
        where: { OR: [{ source: definition.id }, { ticker: { in: symbols } }] },
        select: { ticker: true, isActive: true, source: true },
      });

      const rows = existing.map<ExistingRow>((r) => ({
        symbol: r.ticker,
        isActive: r.isActive,
        source: r.source,
      }));

      // Counts describe what this source WRITES…
      const plan = planSourceReconciliation(rows, symbols, definition.id);
      // …but retirement is judged against everything it still lists.
      const retirement = planSourceReconciliation(rows, ownedSymbols, definition.id);
      plan.deactivated = retirement.deactivated;

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        await upsertBatch(tx, records.slice(i, i + BATCH_SIZE), seenAt);
      }

      // Last, and only inside this transaction, so it cannot happen unless
      // every insert above succeeded. Driven by the plan's explicit list, so
      // the rows changed are exactly the rows counted.
      let deactivated = 0;
      if (plan.deactivated.length > 0) {
        const { count } = await tx.tickers.updateMany({
          where: { ticker: { in: plan.deactivated } },
          // `last_seen_at` is NOT cleared: it must keep recording when the
          // symbol was last genuinely listed.
          data: { isActive: false },
        });
        deactivated = count;
      }

      return {
        created: plan.created.length,
        updated: plan.updated.length,
        reactivated: plan.reactivated.length,
        deactivated,
      };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );
}

/**
 * Fetch and parse one source. Never throws — the outcome carries the failure.
 *
 * Writing happens later, after every source has been parsed, so a symbol
 * claimed by two directories is resolved once and written once.
 */
async function runSource(
  definition: SourceDefinition,
  seenAt: Date,
): Promise<{ outcome: SourceOutcome; records: NormalizedTickerRecord[] }> {
  const startedAt = new Date();
  const empty = {
    source: definition.id,
    startedAt: startedAt.toISOString(),
    recordsReceived: 0,
    recordsAccepted: 0,
    created: 0,
    updated: 0,
    reactivated: 0,
    deactivated: 0,
  };

  if (!definition.enabled) {
    console.log(`${LOG} ${definition.label}: disabled by configuration`);
    return {
      outcome: { ...empty, status: "skipped", finishedAt: new Date().toISOString() },
      records: [],
    };
  }

  try {
    const text = await downloadText(definition.id, definition.url, env.TICKER_CATALOG_REQUEST_TIMEOUT_MS);
    const parsed = definition.parse(text);

    const unknown = Object.entries(parsed.unknownExchangeCodes);
    if (unknown.length > 0) {
      // Loud, because an unmapped venue is a decision to make, not a default
      // to fall back on.
      console.warn(
        `${LOG} ${definition.label}: unmapped exchange code(s) — ${unknown
          .map(([code, n]) => `${code}×${n}`)
          .join(", ")} — imported under a provisional label`,
      );
    }

    return {
      outcome: {
        ...empty,
        status: "success",
        finishedAt: new Date().toISOString(),
        recordsReceived: parsed.rowsReceived,
        recordsAccepted: parsed.records.length,
        ...(unknown.length > 0 ? { unknownExchangeCodes: parsed.unknownExchangeCodes } : {}),
      },
      records: parsed.records,
    };
  } catch (err) {
    // Contained on purpose: this source changes nothing and the others carry on.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} ${definition.label}: FAILED — ${message}`);
    return {
      outcome: {
        ...empty,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: message.slice(0, 300),
      },
      records: [],
    };
  }
}

/**
 * Refresh the whole catalog.
 *
 * @throws only when every enabled source failed — that is a real outage, and
 *         the run should be recorded as failed. A partial failure returns
 *         normally with the per-source detail.
 */
export async function refreshTickerCatalog(): Promise<JobMetadata> {
  const startedAt = Date.now();
  const seenAt = new Date();
  console.log(`${LOG} refresh started`);

  const definitions = sourceDefinitions();

  // -- PHASE 1: fetch and parse every source. Nothing is written yet. --------
  //
  // Sequential rather than parallel: three concurrent multi-megabyte downloads
  // buy nothing on a daily job, and serialising keeps the log readable.
  const parsedBySource = new Map<SourceId, NormalizedTickerRecord[]>();
  const outcomes: SourceOutcome[] = [];

  for (const definition of definitions) {
    const { outcome, records } = await runSource(definition, seenAt);
    outcomes.push(outcome);
    if (outcome.status === "success") parsedBySource.set(definition.id, records);
  }

  const attempted = outcomes.filter((o) => o.status !== "skipped");
  const parseFailed = outcomes.filter((o) => o.status === "failed");

  if (attempted.length > 0 && parsedBySource.size === 0) {
    // Nothing was written, by construction: phase 3 has not run.
    throw new Error(
      `every enabled ticker catalog source failed: ${parseFailed
        .map((o) => `${o.source} (${o.error ?? "unknown"})`)
        .join("; ")}`,
    );
  }

  // -- PHASE 2: resolve contested symbols ONCE, before writing. --------------
  //
  // Applying each source independently would let whichever ran last overwrite
  // the others, making precedence decorative: the Cboe index directory runs
  // third and would have filed Spero Therapeutics as a benchmark index.
  // Merging first means each symbol is written exactly once, by its winner.
  const { records: winners, collisions } = mergeBySymbol([...parsedBySource.values()]);
  if (collisions.length > 0) {
    console.warn(
      `${LOG} ${collisions.length} symbol(s) claimed by more than one source - ` +
        collisions
          .slice(0, 10)
          .map((c) => `${c.symbol}: ${c.winner} over ${c.loser}`)
          .join(", "),
    );
  }

  const winnersBySource = new Map<SourceId, NormalizedTickerRecord[]>();
  for (const record of winners) {
    const list = winnersBySource.get(record.source) ?? [];
    list.push(record);
    winnersBySource.set(record.source, list);
  }

  // -- PHASE 3: write, one transaction per source. ---------------------------
  for (const definition of definitions) {
    const owned = parsedBySource.get(definition.id);
    if (!owned) continue; // skipped or failed: this source changes nothing

    const outcome = outcomes.find((o) => o.source === definition.id)!;
    const written = winnersBySource.get(definition.id) ?? [];
    try {
      const applied = await applySource(
        definition,
        written,
        owned.map((r) => r.symbol),
        seenAt,
      );
      Object.assign(outcome, applied);
      console.log(
        `${LOG} ${definition.label}: received=${outcome.recordsReceived} ` +
          `accepted=${outcome.recordsAccepted} written=${written.length} ` +
          `created=${applied.created} updated=${applied.updated} ` +
          `reactivated=${applied.reactivated} deactivated=${applied.deactivated}`,
      );
    } catch (err) {
      // A write failure is contained exactly like a download failure: this
      // source's transaction rolled back, the others keep their results.
      const message = err instanceof Error ? err.message : String(err);
      outcome.status = "failed";
      outcome.error = message.slice(0, 300);
      console.error(`${LOG} ${definition.label}: WRITE FAILED - ${message}`);
    }
  }

  const failed = outcomes.filter((o) => o.status === "failed");
  if (attempted.length > 0 && failed.length === attempted.length) {
    throw new Error(
      `every enabled ticker catalog source failed: ${failed
        .map((o) => `${o.source} (${o.error ?? "unknown"})`)
        .join("; ")}`,
    );
  }

  const totals = await prisma.tickers.groupBy({ by: ["isActive"], _count: { _all: true } });
  const activeTotal = totals.find((t) => t.isActive === true)?._count._all ?? 0;
  const inactiveTotal = totals.find((t) => t.isActive === false)?._count._all ?? 0;

  const durationMs = Date.now() - startedAt;
  console.log(
    `${LOG} refresh ${failed.length > 0 ? "completed WITH FAILURES" : "completed"} ` +
      `duration=${durationMs}ms activeTotal=${activeTotal} inactiveTotal=${inactiveTotal}`,
  );

  return {
    // A partial failure is a healthy-but-degraded outcome, not a success.
    ...(failed.length > 0 ? { status: "success_without_change" as const } : {}),
    sources: outcomes,
    collisions: collisions.length,
    activeTotal,
    inactiveTotal,
    sourcesSucceeded: outcomes.filter((o) => o.status === "success").length,
    sourcesFailed: failed.length,
  };
}

// Manual run: `npm run ticker-catalog:refresh`.
//
// Guarded, so importing this module from the worker or a test does not fire
// three downloads and a catalog write as a side effect.
if (isMainModule(import.meta.url)) {
  void runJobAsScript(JOB_NAME, refreshTickerCatalog);
}
