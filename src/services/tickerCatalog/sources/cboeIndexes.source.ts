import {
  SOURCE_IDS,
  TickerSourceError,
  normalizeSymbol,
  type NormalizedTickerRecord,
  type SourceParseResult,
} from "../types.js";

/**
 * SOURCE — Cboe's official US index definitions.
 *
 *   https://cdn.cboe.com/api/global/us_indices/definitions/all_indices.json
 *
 * SPX, VIX and RUT are not listed securities: they appear in neither Nasdaq
 * directory, because they are indices rather than things you can buy a share
 * of. Reddit discusses them constantly, so a catalog built only from the two
 * equity directories would never recognize them.
 *
 * This is a documented CDN JSON endpoint — a plain GET, no HTML parsing, no
 * browser automation. Verified live: 200, 1.4 MB, 2,481 definitions.
 *
 * FORMAT
 *
 *   [ { "index_symbol": "SPX",
 *       "name": "Standard & Poor's 500",
 *       "description": "...", "index_family": "...", ... }, ... ]
 *
 * Only `index_symbol` and `name` are read. The rest of the payload describes
 * calculation windows and tick behaviour, which the catalog has no use for.
 *
 * EVERY RECORD IS `INDEX`, from the SOURCE, not from its name. The endpoint is
 * an index directory — that IS the authoritative metadata — so matching on
 * "Index" appearing in a name would be inventing a signal we already have, and
 * would drop SPX, whose official name is "Standard & Poor's 500".
 */

export const CBOE_EXCHANGE_LABEL = "CBOE";

/** Default endpoint; overridable via CBOE_INDEX_CATALOG_SOURCE_URL. */
export const CBOE_INDEX_DEFAULT_URL =
  "https://cdn.cboe.com/api/global/us_indices/definitions/all_indices.json";

/**
 * A plausible directory carries thousands of definitions. This floor only has
 * to be high enough to reject an error page or a truncated body.
 */
export const MIN_EXPECTED_CBOE_RECORDS = 10;

/**
 * The flagship index must be present.
 *
 * A payload that parses, clears the floor, and yet lacks SPX is not the Cboe
 * index directory — it is something else that happens to be JSON. Failing here
 * keeps the existing index rows untouched instead of deactivating them against
 * a stranger's data.
 */
export const CBOE_SENTINEL_SYMBOL = "SPX";

type CboeIndexDefinition = {
  index_symbol?: unknown;
  name?: unknown;
  description?: unknown;
};

export function parseCboeIndexes(text: string): SourceParseResult {
  const sourceId = SOURCE_IDS.cboeIndexes;
  if (!text || text.trim().length === 0) {
    throw new TickerSourceError(sourceId, "source is empty");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    // An HTML error page with a 200 status lands here — the most likely way
    // this endpoint fails without saying so.
    throw new TickerSourceError(
      sourceId,
      `source is not valid JSON: ${err instanceof Error ? err.message.slice(0, 120) : "parse error"}`,
    );
  }

  const entries = Array.isArray(payload)
    ? payload
    : // Tolerate a future `{ data: [...] }` envelope without accepting anything.
      Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data)
      : null;

  if (!entries) {
    throw new TickerSourceError(sourceId, "source JSON is not a list of index definitions");
  }

  const records: NormalizedTickerRecord[] = [];
  const seen = new Set<string>();
  let duplicatesSkipped = 0;
  let malformedSkipped = 0;

  for (const raw of entries) {
    const entry = raw as CboeIndexDefinition;
    const rawSymbol = typeof entry.index_symbol === "string" ? entry.index_symbol : "";
    // Cboe quotes carry a caret prefix elsewhere in its API (`^SPX`); the
    // definitions do not, but stripping it costs nothing and prevents a
    // duplicate universe if that ever changes.
    const symbol = normalizeSymbol(rawSymbol.replace(/^\^/, ""));

    const name =
      typeof entry.name === "string" && entry.name.trim().length > 0
        ? entry.name.trim()
        : typeof entry.description === "string"
          ? entry.description.trim()
          : "";

    if (!symbol || name.length === 0) {
      malformedSkipped += 1;
      continue;
    }
    if (seen.has(symbol)) {
      duplicatesSkipped += 1;
      continue;
    }
    seen.add(symbol);

    records.push({
      symbol,
      companyName: name,
      exchange: CBOE_EXCHANGE_LABEL,
      securityType: "INDEX",
      source: sourceId,
    });
  }

  if (records.length === 0) {
    throw new TickerSourceError(
      sourceId,
      "source produced zero index symbols — preserving the existing index records",
    );
  }
  if (records.length < MIN_EXPECTED_CBOE_RECORDS) {
    throw new TickerSourceError(
      sourceId,
      `source produced only ${records.length} indices, below the ${MIN_EXPECTED_CBOE_RECORDS} expected — treating as truncated`,
    );
  }
  if (!seen.has(CBOE_SENTINEL_SYMBOL)) {
    throw new TickerSourceError(
      sourceId,
      `source parsed but does not contain ${CBOE_SENTINEL_SYMBOL} — this is not the Cboe index directory`,
    );
  }

  return {
    records,
    rowsReceived: entries.length,
    testIssuesSkipped: 0,
    duplicatesSkipped,
    malformedSkipped,
    unknownExchangeCodes: {},
    // The definitions payload carries no file-level timestamp.
    sourceCreatedAt: null,
  };
}
