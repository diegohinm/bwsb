/**
 * The shape every catalog source must produce.
 *
 * One normalized record type is what keeps the job free of source-specific
 * branching: adapters know about pipe-delimited text, JSON payloads and
 * exchange codes; the job knows only about symbols. Adding a fourth directory
 * later means writing one adapter, not editing the reconciler.
 */

/**
 * Instrument classification.
 *
 * `OTHER` exists so an adapter is never forced to guess. A record whose type is
 * genuinely unknown is more useful stored honestly than filed under STOCK,
 * where it would misreport what the symbol is.
 */
export const SECURITY_TYPES = ["STOCK", "ETF", "INDEX", "OTHER"] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

/** Stable identifiers for provenance. Written to `tickers.source`. */
export const SOURCE_IDS = {
  nasdaqListed: "NASDAQ_TRADER_NASDAQ_LISTED",
  otherListed: "NASDAQ_TRADER_OTHER_LISTED",
  cboeIndexes: "CBOE_INDEX_DIRECTORY",
} as const;

export type SourceId = (typeof SOURCE_IDS)[keyof typeof SOURCE_IDS];

export type NormalizedTickerRecord = {
  symbol: string;
  companyName: string;
  exchange: string;
  securityType: SecurityType;
  source: SourceId;
};

/** What an adapter reports back, whether it succeeded or not. */
export type SourceParseResult = {
  records: NormalizedTickerRecord[];
  /** Rows seen in the payload, before any filtering. */
  rowsReceived: number;
  testIssuesSkipped: number;
  duplicatesSkipped: number;
  malformedSkipped: number;
  /**
   * Exchange codes the adapter did not recognize, with a count each. Reported
   * rather than guessed at: a new code must be a decision, not a silent
   * reclassification.
   */
  unknownExchangeCodes: Record<string, number>;
  /** Source-supplied timestamp, when the payload carries one. */
  sourceCreatedAt: Date | null;
};

/**
 * A source refused to produce a usable dataset.
 *
 * THIS IS THE FAILURE CONTRACT. A source that throws must leave its slice of
 * the catalog exactly as it was — no upserts, and above all no deactivations.
 * Adapters throw rather than returning a small clean result, because "the
 * exchange has four securities today" is never a real answer.
 */
export class TickerSourceError extends Error {
  readonly sourceId: string;

  constructor(sourceId: string, message: string) {
    super(message);
    this.name = "TickerSourceError";
    this.sourceId = sourceId;
  }
}

/** Trim and uppercase — nothing else. */
export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return symbol.length > 0 ? symbol : null;
}
