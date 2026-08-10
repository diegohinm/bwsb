import { readPipeDelimited } from "../download.js";
import {
  SOURCE_IDS,
  TickerSourceError,
  normalizeSymbol,
  type NormalizedTickerRecord,
  type SourceParseResult,
} from "../types.js";

/**
 * SOURCE — Nasdaq Trader's Nasdaq-listed symbol directory.
 *
 *   https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt
 *
 * Everything listed ON Nasdaq: the equities and the Nasdaq-listed ETFs. Its
 * companion, otherlisted.txt, carries every other US exchange — the two do not
 * overlap, which is why both are needed and why neither alone is "the market".
 *
 * FORMAT (verified against the live file: 346 KB, 5,584 data rows)
 *
 *   Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
 *   AAAP|Pacer Barings CLO Market Flex ETF|G|N|N|100|Y|N
 *   ...
 *   File Creation Time: 0807202621:31|||||||
 *
 * ETF CLASSIFICATION COMES FROM THE `ETF` COLUMN, never from the name. The
 * directory states it, so reading "ETF" out of a company name would be
 * guessing at something already known — and would misfile every fund whose
 * name omits the word.
 */

export const NASDAQ_LISTED_COLUMNS = ["Symbol", "Security Name", "Test Issue", "ETF"] as const;

export const NASDAQ_EXCHANGE_LABEL = "NASDAQ";

/**
 * Below this the payload is treated as truncated rather than as a small market.
 * The live directory carries ~5,500 securities; this is a smoke alarm set far
 * below the real figure, not a quota.
 */
export const MIN_EXPECTED_NASDAQ_RECORDS = 500;

export function parseNasdaqListed(text: string): SourceParseResult {
  const sourceId = SOURCE_IDS.nasdaqListed;
  if (!text || text.trim().length === 0) {
    throw new TickerSourceError(sourceId, "source is empty");
  }

  const { index, rows, sourceCreatedAt } = readPipeDelimited(
    sourceId,
    text,
    NASDAQ_LISTED_COLUMNS,
  );

  const symbolAt = index.get("Symbol")!;
  const nameAt = index.get("Security Name")!;
  const testAt = index.get("Test Issue")!;
  const etfAt = index.get("ETF")!;

  const records: NormalizedTickerRecord[] = [];
  const seen = new Set<string>();
  let testIssuesSkipped = 0;
  let duplicatesSkipped = 0;
  let malformedSkipped = 0;

  for (const line of rows) {
    const cells = line.split("|");
    if (cells.length <= etfAt) {
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
    seen.add(symbol);

    records.push({
      symbol,
      companyName,
      exchange: NASDAQ_EXCHANGE_LABEL,
      securityType: (cells[etfAt] ?? "").trim().toUpperCase() === "Y" ? "ETF" : "STOCK",
      source: sourceId,
    });
  }

  if (records.length === 0) {
    throw new TickerSourceError(
      sourceId,
      "source produced zero securities — refusing to treat this as an empty exchange",
    );
  }
  if (records.length < MIN_EXPECTED_NASDAQ_RECORDS) {
    throw new TickerSourceError(
      sourceId,
      `source produced only ${records.length} securities, below the ${MIN_EXPECTED_NASDAQ_RECORDS} expected — treating as truncated`,
    );
  }

  return {
    records,
    rowsReceived: rows.length,
    testIssuesSkipped,
    duplicatesSkipped,
    malformedSkipped,
    unknownExchangeCodes: {},
    sourceCreatedAt,
  };
}
