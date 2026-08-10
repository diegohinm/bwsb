import { SOURCE_IDS, type NormalizedTickerRecord, type SourceId } from "./types.js";

/**
 * Merging several directories into one catalog, and deciding what to switch off.
 *
 * Pure. The database work is a batched upsert plus one `updateMany` per source;
 * the DECISIONS — which source wins a contested symbol, and which symbols may
 * be deactivated — are what destroy data when wrong, so they live here where
 * every case can be tested without a database.
 */

/**
 * Which source wins when the same symbol arrives from more than one.
 *
 * A LISTED SECURITY OUTRANKS AN INDEX BENCHMARK THAT SHARES ITS SYMBOL.
 *
 * This is a deliberate refinement of the "index source is authoritative" rule,
 * and it was made after measuring the collisions on live data. Cboe's index
 * directory contains benchmark products whose symbols collide with real
 * tradable securities:
 *
 *   SPRO  Spero Therapeutics (Nasdaq)  vs  Cboe S&P 500 Buffer Protect Index
 *   BFLY  Butterfly Network (NYSE)     vs  Cboe S&P 500 Iron Butterfly Index
 *   SPAI  Safe Pro Group (Nasdaq)      vs  Cboe Dividend Aristocrat Index
 *   …11 in total
 *
 * Letting the index win those would file eleven companies people actually
 * trade as untradable benchmarks. Someone writing "SPRO" on Reddit means the
 * biotech, not a structured-product index.
 *
 * The rule the refinement was meant to protect is untouched: SPX, VIX, RUT,
 * XSP, DJX, OEX and VXN appear in NEITHER listing directory — verified against
 * the live files — so they face no competition and stay INDEX on CBOE. The
 * index directory remains authoritative for every symbol that is only an index,
 * which is the case that mattered.
 */
export const SOURCE_PRECEDENCE: readonly SourceId[] = [
  SOURCE_IDS.nasdaqListed,
  SOURCE_IDS.otherListed,
  SOURCE_IDS.cboeIndexes,
];

function rank(source: SourceId): number {
  const at = SOURCE_PRECEDENCE.indexOf(source);
  return at === -1 ? Number.MAX_SAFE_INTEGER : at;
}

export type SymbolCollision = {
  symbol: string;
  winner: SourceId;
  loser: SourceId;
};

export type MergeResult = {
  records: NormalizedTickerRecord[];
  /** Reported, never silent: a collision means two directories disagree. */
  collisions: SymbolCollision[];
};

/**
 * Merge records from every successful source into one row per symbol.
 *
 * Input order does not affect the outcome — precedence does.
 */
export function mergeBySymbol(
  groups: readonly (readonly NormalizedTickerRecord[])[],
): MergeResult {
  const winners = new Map<string, NormalizedTickerRecord>();
  const collisions: SymbolCollision[] = [];

  for (const group of groups) {
    for (const record of group) {
      const held = winners.get(record.symbol);
      if (!held) {
        winners.set(record.symbol, record);
        continue;
      }
      if (held.source === record.source) continue; // in-source dupes already dropped

      const incomingWins = rank(record.source) < rank(held.source);
      const winner = incomingWins ? record : held;
      const loser = incomingWins ? held : record;
      collisions.push({ symbol: record.symbol, winner: winner.source, loser: loser.source });
      winners.set(record.symbol, winner);
    }
  }

  return { records: [...winners.values()], collisions };
}

export type ExistingRow = {
  symbol: string;
  isActive: boolean | null;
  source: string | null;
};

export type SourcePlan = {
  /** Symbols this source supplied that the catalog has never held. */
  created: string[];
  /** Symbols this source supplied that already existed. */
  updated: string[];
  /** Previously switched off, supplied again. */
  reactivated: string[];
  /** Owned by this source, absent from its validated dataset. Switched off. */
  deactivated: string[];
};

/**
 * Work out one source's effect on the catalog.
 *
 * DEACTIVATION IS SCOPED BY PROVENANCE, and that scoping is the whole reason
 * `tickers.source` exists. Nasdaq's directory is silent about whether SPX is
 * still a Cboe index; if a successful NASDAQ refresh were allowed to deactivate
 * every symbol it did not mention, it would switch off the entire index and
 * NYSE universes. A source may only retire rows it owns.
 *
 * Rows with a NULL source are owned by no importer and are never touched.
 *
 * @param existing every catalog row (the caller passes the full set; filtering
 *        by source happens here so the rule is visible in one place)
 * @param incoming symbols from a dataset that has ALREADY been validated. This
 *        function cannot tell a truncated download from a real one — calling it
 *        with an unvalidated payload is what would empty a universe.
 */
export function planSourceReconciliation(
  existing: readonly ExistingRow[],
  incoming: readonly string[],
  sourceId: SourceId,
): SourcePlan {
  const incomingSet = new Set(incoming);
  const byId = new Map(existing.map((row) => [row.symbol, row]));

  const created: string[] = [];
  const updated: string[] = [];
  const reactivated: string[] = [];

  for (const symbol of incomingSet) {
    const row = byId.get(symbol);
    if (!row) {
      created.push(symbol);
      continue;
    }
    updated.push(symbol);
    // `null` counts too: a row that never carried an explicit state is being
    // given one for the first time.
    if (row.isActive !== true) reactivated.push(symbol);
  }

  const deactivated = existing
    .filter(
      (row) =>
        row.source === sourceId && row.isActive === true && !incomingSet.has(row.symbol),
    )
    .map((row) => row.symbol);

  return { created, updated, reactivated, deactivated };
}
