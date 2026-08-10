import { readPipeDelimited } from "../download.js";
import {
  SOURCE_IDS,
  TickerSourceError,
  normalizeSymbol,
  type NormalizedTickerRecord,
  type SourceParseResult,
} from "../types.js";

/**
 * SOURCE — Nasdaq Trader's Other Exchange-Listed symbol directory.
 *
 *   https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt
 *
 * Every US exchange EXCEPT Nasdaq. The previous iteration kept only `N`, which
 * left out NYSE Arca — where SPY, IWM and most of the ETFs Reddit actually
 * argues about are listed. All recognized codes are imported now.
 *
 * FORMAT (verified live: 534 KB, 7,529 data rows)
 *
 *   ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
 *   AAA|Alternative Access First Priority CLO Bond ETF|P|AAA|Y|100|N|AAA
 *
 * SYMBOLS KEEP THEIR PUNCTUATION. `AAC.U` is a unit, `ABR$D` a preferred
 * series, `ACHR.W` a warrant — stripping non-letters would merge distinct
 * securities onto one row.
 */

export const OTHER_LISTED_COLUMNS = [
  "ACT Symbol",
  "Security Name",
  "Exchange",
  "ETF",
  "Test Issue",
] as const;

/**
 * Exchange codes this directory uses.
 *
 * An unrecognized code is NEVER folded into one of these. Nasdaq adds venues —
 * `M` (NYSE Texas) already appears — and quietly filing a new one under NYSE
 * would misreport where a security trades. Unknown codes are imported under a
 * clearly provisional label and reported for a human decision.
 */
export const EXCHANGE_CODE_LABELS: Readonly<Record<string, string>> = {
  N: "NYSE",
  A: "NYSE_AMERICAN",
  P: "NYSE_ARCA",
  Z: "BATS_CBOE",
  V: "IEX",
};

/** Prefix for a code we have not mapped yet. Visibly provisional on purpose. */
export const UNKNOWN_EXCHANGE_PREFIX = "UNKNOWN_";

export const MIN_EXPECTED_OTHER_LISTED_RECORDS = 500;

export function labelForExchangeCode(code: string): {
  label: string;
  known: boolean;
} {
  const normalized = code.trim().toUpperCase();
  const label = EXCHANGE_CODE_LABELS[normalized];
  return label
    ? { label, known: true }
    : { label: `${UNKNOWN_EXCHANGE_PREFIX}${normalized || "BLANK"}`, known: false };
}

export function parseOtherListed(text: string): SourceParseResult {
  const sourceId = SOURCE_IDS.otherListed;
  if (!text || text.trim().length === 0) {
    throw new TickerSourceError(sourceId, "source is empty");
  }

  const { index, rows, sourceCreatedAt } = readPipeDelimited(
    sourceId,
    text,
    OTHER_LISTED_COLUMNS,
  );

  const symbolAt = index.get("ACT Symbol")!;
  const nameAt = index.get("Security Name")!;
  const exchangeAt = index.get("Exchange")!;
  const etfAt = index.get("ETF")!;
  const testAt = index.get("Test Issue")!;

  const records: NormalizedTickerRecord[] = [];
  const seen = new Set<string>();
  const unknownExchangeCodes: Record<string, number> = {};
  let testIssuesSkipped = 0;
  let duplicatesSkipped = 0;
  let malformedSkipped = 0;

  for (const line of rows) {
    const cells = line.split("|");
    if (cells.length <= Math.max(exchangeAt, etfAt, testAt)) {
      malformedSkipped += 1;
      continue;
    }

    if ((cells[testAt] ?? "").trim().toUpperCase() === "Y") {
      testIssuesSkipped += 1;
      continue;
    }

    const symbol = normalizeSymbol(cells[symbolAt] ?? "");
    const companyName = (cells[nameAt] ?? "").trim();
    if (!symbol || companyName.length === 0) {
      malformedSkipped += 1;
      continue;
    }
    if (seen.has(symbol)) {
      duplicatesSkipped += 1;
      continue;
    }

    const rawCode = (cells[exchangeAt] ?? "").trim().toUpperCase();
    const { label, known } = labelForExchangeCode(rawCode);
    if (!known) {
      unknownExchangeCodes[rawCode || "BLANK"] =
        (unknownExchangeCodes[rawCode || "BLANK"] ?? 0) + 1;
    }

    seen.add(symbol);
    records.push({
      symbol,
      companyName,
      exchange: label,
      securityType: (cells[etfAt] ?? "").trim().toUpperCase() === "Y" ? "ETF" : "STOCK",
      source: sourceId,
    });
  }

  if (records.length === 0) {
    throw new TickerSourceError(
      sourceId,
      "source produced zero securities — refusing to treat this as an empty universe",
    );
  }
  if (records.length < MIN_EXPECTED_OTHER_LISTED_RECORDS) {
    throw new TickerSourceError(
      sourceId,
      `source produced only ${records.length} securities, below the ${MIN_EXPECTED_OTHER_LISTED_RECORDS} expected — treating as truncated`,
    );
  }

  return {
    records,
    rowsReceived: rows.length,
    testIssuesSkipped,
    duplicatesSkipped,
    malformedSkipped,
    unknownExchangeCodes,
    sourceCreatedAt,
  };
}
