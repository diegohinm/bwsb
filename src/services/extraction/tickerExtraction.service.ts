/**
 * Ticker extraction — turning free Reddit text into validated securities.
 *
 * THE GOVERNING TRADE-OFF
 *
 * A missed mention costs one badge. A wrong one corrupts mention counts,
 * sentiment aggregation, Popular Tickers, Arena rankings and search — every
 * surface that reads the association. So this file is deliberately biased
 * toward rejection, and every acceptance path has to earn itself.
 *
 * TWO GATES, BOTH MANDATORY
 *
 *   1. THE CATALOG. A token becomes a candidate only if it is a row in
 *      `tickers`. This is what the old extractor was missing on its cashtag
 *      path — `$DRAM`, `$SPCX`, `$BURU` were accepted as securities purely
 *      because they were 1-5 letters after a dollar sign, and those rows are in
 *      the database today. The FK on the association tables now makes the same
 *      guarantee at the storage layer, so this gate cannot be bypassed by a
 *      future caller.
 *
 *   2. CONFIDENCE. Everything found is returned; only matches at or above
 *      DISPLAY_THRESHOLD are shown publicly. Weak matches are still stored,
 *      because "we saw this and rejected it" is the record you need to tune the
 *      ladder later, and it costs nothing to keep.
 *
 * THE LADDER
 *
 *   0.98  $NVDA               cashtag, catalog-validated
 *   0.92  "NVDA stock"        bare symbol with a security noun beside it
 *   0.85  NVDA                bare symbol, unambiguous in the catalog
 *   0.85  "Nvidia"            unambiguous company name
 *   0.80  "Apple stock"       context-gated alias with a security noun beside it
 *   ----  "AI stocks"         ambiguous symbol, bare mention          → rejected
 *   ----  "I ate an apple"    context-gated alias, no adjacent noun → not returned
 *
 * DISPLAY_THRESHOLD sits at 0.75, so the last two never reach a reader.
 *
 * WHY THOSE LAST TWO ROWS ARE SO STRICT — measured, not assumed:
 *
 *   - A gate that asked "is this text financial" produced 168 C3.ai badges on
 *     the live corpus. Every one was artificial intelligence.
 *   - Tightening it to "is a security noun adjacent" still left 57, and a
 *     sample of those was again 100% the technology: "AI stocks", "AI
 *     spending", "AI Memory Demand".
 *   - So a common-word SYMBOL now requires evidence the author supplied — a
 *     `$` cashtag or the company name — and a bare mention is recorded but
 *     never shown.
 *
 * Context-gated ALIASES keep the adjacency rule, because a company name
 * already carries most of the signal; "price target" is excluded by phrase
 * rather than by context, since it is financial vocabulary containing a
 * company name and no context test can separate the two.
 *
 * No network calls and no model inference: this is deterministic, which is what
 * lets the same function run in ingestion, in the backfill, and in a unit test
 * and produce identical results.
 */

export type TickerMatchSource = "cashtag" | "symbol" | "alias";

export type TickerMatch = {
  symbol: string;
  confidence: number;
  source: TickerMatchSource;
  /** The literal text that produced the match, for auditing. */
  matchedText: string;
  /** Character offset of the first occurrence — drives ordering. */
  position: number;
};

/** An entry in the validation catalog. */
export type CatalogTicker = {
  symbol: string;
  /** The ticker is also an everyday word, so bare mentions need context. */
  isCommonWord: boolean;
};

export type AliasEntry = {
  alias: string;
  symbol: string;
  /** Also an ordinary word or a place — needs a financial cue to count. */
  requiresContext: boolean;
};

export type TickerCatalog = {
  bySymbol: Map<string, CatalogTicker>;
  aliases: Map<string, AliasEntry>;
};

/** Below this, an association exists internally but is never rendered. */
export const DISPLAY_THRESHOLD = 0.75;

const CONFIDENCE = {
  cashtag: 0.98,
  symbolWithContext: 0.92,
  symbol: 0.85,
  alias: 0.85,
  aliasWithContext: 0.8,
  /** Deliberately below the threshold: recorded, not shown. */
  commonWordNoContext: 0.55,
} as const;

/**
 * Nouns that, standing IMMEDIATELY beside a token, mean the token is a
 * security rather than the English word.
 *
 * Adjacency is the whole point. A generic "is this text financial" test is
 * useless on r/wallstreetbets, where every post is financial — it let "The AI
 * Cloud Consolidation Wave" become a C3.ai badge 168 times, and turned every
 * "Price Target" into Target Corp. These have to be next to the token, not
 * somewhere in the same paragraph.
 */
const ADJACENT_SECURITY_NOUNS = [
  "stock", "stocks", "share", "shares", "calls", "call", "puts", "put",
  "options", "option", "leaps", "earnings", "ticker", "position", "holdings",
  "shorts", "longs", "dividend", "buyback", "split",
];

/**
 * The wider set, for COMPANY ALIASES only.
 *
 * "Meta is trading at a discount" is plainly about the security, and demanding
 * a hard noun there would cost real mentions. An alias is already a company
 * name, so a verb that takes a security as its subject is enough.
 *
 * The strict set above stays strict for common-word SYMBOLS, where the same
 * leniency would read "should I buy AI" as C3.ai. The two classes differ in how
 * much the token itself already tells you, so they get different bars.
 */
const ALIAS_CONTEXT_WORDS = [
  ...ADJACENT_SECURITY_NOUNS,
  "trading", "traded", "rallied", "dipped", "jumped", "plunged", "surged",
  "beat", "missed", "guidance", "upgraded", "downgraded", "valuation",
  "bought", "buying", "sold", "selling", "owns", "owning", "holding",
  "bullish", "bearish", "undervalued", "overvalued", "revenue",
];

/**
 * Phrases where a company alias appears but means something else.
 *
 * "Price target" is the one that matters: it is financial vocabulary AND
 * contains a company name, so no amount of context-checking separates them.
 * The phrase has to be recognized and skipped outright.
 */
const BLOCKED_PHRASES = [
  "price target", "target price", "pt target", "targets", "on target",
  "price targets", "meta analysis", "meta data", "meta level",
  "block chain", "blockchain", "open ai", "openai",
];

/**
 * Tokens that are never a security on their own.
 *
 * This is belt-and-braces on top of the catalog gate — most of these are not in
 * `tickers` anyway — but it also covers the case where a real symbol collides
 * with a term so common that a bare mention is nearly always the English word.
 * A `$` prefix bypasses it: an author who writes `$DD` means the security.
 */
const STOPWORDS = new Set([
  "CEO", "CFO", "CTO", "COO", "IPO", "USA", "USD", "EUR", "GBP", "GDP", "EPS",
  "ETF", "SEC", "FED", "FDA", "IRS", "DOJ", "FTC", "IMO", "IMHO", "TLDR", "DD",
  "YOLO", "FOMO", "FUD", "ATH", "ATL", "EOD", "EOW", "EOY", "OTM", "ITM", "ATM",
  "PT", "TA", "PE", "PS", "EV", "IV", "RSI", "MACD", "SMA", "EMA", "VWAP",
  "AH", "PM", "AM", "US", "UK", "EU", "UN", "NYSE", "OP", "EDIT", "TIL", "AMA",
  "WSB", "LOL", "LMAO", "WTF", "IDK", "TBH", "FYI", "ASAP", "AKA", "ETA",
  "Q1", "Q2", "Q3", "Q4", "YTD", "QOQ", "YOY", "CAGR", "ROI", "ROE", "EBITDA",
  "GAAP", "SPAC", "REIT", "LLC", "INC", "LTD", "CORP", "NFT", "API", "CPU",
  "GPU", "RAM", "DRAM", "SSD", "HDD", "LLM", "ML", "AR", "VR", "EPS",
]);

/**
 * Words whose presence makes a sentence recognizably about markets.
 *
 * Used for the context gate. Kept broad but concrete — no sentiment words, no
 * generic business vocabulary, because "growth" and "company" appear in plenty
 * of text that has nothing to do with a security.
 */
const FINANCIAL_CUES = [
  "stock", "stocks", "share", "shares", "ticker", "calls", "call", "puts",
  "put", "option", "options", "strike", "expiry", "earnings", "guidance",
  "revenue", "eps", "dividend", "buy", "bought", "sell", "sold", "short",
  "long", "position", "portfolio", "bullish", "bearish", "rally", "dip",
  "market", "nasdaq", "nyse", "premarket", "yolo", "leaps", "iv", "squeeze",
  "valuation", "pe ratio", "market cap", "float", "analyst", "price target",
  "upgrade", "downgrade", "split", "buyback", "invest", "investing",
  "investor", "trade", "trading", "trader", "holding", "hold", "bagholder",
  "moon", "tendies", "diamond hands", "cost basis", "premium", "assigned",
];

const CASHTAG = /\$([A-Za-z][A-Za-z.\-]{0,5})\b/g;
const BARE_SYMBOL = /\b([A-Z]{1,5})\b/g;

/** Build the lookup structures the extractor needs from raw catalog rows. */
export function buildCatalog(
  tickers: Array<{ ticker: string; isCommonWord?: boolean | null }>,
  aliases: Array<{ alias: string; ticker: string; requiresContext?: boolean | null }> = [],
): TickerCatalog {
  const bySymbol = new Map<string, CatalogTicker>();
  for (const t of tickers) {
    const symbol = t.ticker.trim().toUpperCase();
    if (!symbol) continue;
    bySymbol.set(symbol, { symbol, isCommonWord: t.isCommonWord === true });
  }

  const aliasMap = new Map<string, AliasEntry>();
  for (const a of aliases) {
    const alias = a.alias.trim().toLowerCase();
    const symbol = a.ticker.trim().toUpperCase();
    // An alias pointing at a symbol we cannot validate is dropped rather than
    // trusted — the catalog stays the single authority.
    if (!alias || !bySymbol.has(symbol)) continue;
    aliasMap.set(alias, { alias, symbol, requiresContext: a.requiresContext === true });
  }

  return { bySymbol, aliases: aliasMap };
}

/** True when the text reads as being about markets. */
export function hasFinancialContext(text: string): boolean {
  const haystack = ` ${text.toLowerCase()} `;
  for (const cue of FINANCIAL_CUES) {
    if (haystack.includes(` ${cue} `) || haystack.includes(` ${cue}.`) ||
        haystack.includes(` ${cue},`)) {
      return true;
    }
  }
  // A cashtag anywhere is itself proof the text is about securities.
  return /\$[A-Za-z]{1,5}\b/.test(text);
}

/**
 * Is there a financial cue near this position?
 *
 * Local rather than whole-document: a 4,000-word DD about NVDA should not turn
 * an unrelated "Target" in the last paragraph into TGT.
 */
function hasNearbyContext(text: string, position: number, window = 120): boolean {
  const start = Math.max(0, position - window);
  const end = Math.min(text.length, position + window);
  return hasFinancialContext(text.slice(start, end));
}

/**
 * Is a security noun standing right next to this token?
 *
 * "NVDA stock" and "AI calls" pass; "the AI cloud wave" and "revenue targets"
 * do not. The window is one or two words, not a paragraph.
 */
function hasAdjacentSecurityNoun(
  text: string,
  start: number,
  length: number,
  vocabulary: string[] = ADJACENT_SECURITY_NOUNS,
): boolean {
  const before = text.slice(Math.max(0, start - 30), start).toLowerCase();
  const after = text.slice(start + length, start + length + 30).toLowerCase();
  const words = (chunk: string) => chunk.split(/[^a-z0-9$']+/).filter(Boolean);
  const near = [...words(before).slice(-3), ...words(after).slice(0, 3)];
  return near.some((w) => vocabulary.includes(w));
}

/** Is this occurrence part of a phrase that means something else? */
function insideBlockedPhrase(lowerText: string, start: number, length: number): boolean {
  const from = Math.max(0, start - 20);
  const window = lowerText.slice(from, start + length + 20);
  const offset = start - from;
  return BLOCKED_PHRASES.some((phrase) => {
    let at = window.indexOf(phrase);
    while (at >= 0) {
      // The match counts only if it actually covers this occurrence.
      if (at <= offset && at + phrase.length >= offset + length) return true;
      at = window.indexOf(phrase, at + 1);
    }
    return false;
  });
}

/**
 * Find every validated security mentioned in `text`.
 *
 * Returns matches ordered by: explicit cashtag first, then first appearance,
 * then confidence — the ordering the feed renders badges in. Duplicates are
 * collapsed to the single strongest match, so "$NVDA NVDA Nvidia" yields one
 * NVDA at cashtag confidence.
 */
export function extractTickerMatches(
  text: string | null | undefined,
  catalog: TickerCatalog,
): TickerMatch[] {
  if (!text) return [];

  const best = new Map<string, TickerMatch>();

  /** Keep the strongest match per symbol; ties keep the earliest. */
  const offer = (m: TickerMatch) => {
    const existing = best.get(m.symbol);
    if (!existing) {
      best.set(m.symbol, m);
      return;
    }
    if (m.confidence > existing.confidence) {
      // Keep the earliest position seen for this symbol so ordering stays
      // stable when a later mention happens to be the stronger one.
      best.set(m.symbol, { ...m, position: Math.min(existing.position, m.position) });
    } else if (m.position < existing.position) {
      best.set(m.symbol, { ...existing, position: m.position });
    }
  };

  // 1. Cashtags. Strongest signal, but still catalog-validated: the `$` proves
  //    intent, not existence.
  for (const m of text.matchAll(CASHTAG)) {
    const raw = m[1];
    const symbol = raw.toUpperCase().replace(/[.\-]+$/, "");
    if (!catalog.bySymbol.has(symbol)) continue;
    offer({
      symbol,
      confidence: CONFIDENCE.cashtag,
      source: "cashtag",
      matchedText: m[0],
      position: m.index ?? 0,
    });
  }

  const lowerAll = text.toLowerCase();

  // 2. Bare uppercase symbols.
  for (const m of text.matchAll(BARE_SYMBOL)) {
    const symbol = m[1].toUpperCase();
    if (STOPWORDS.has(symbol)) continue;
    const entry = catalog.bySymbol.get(symbol);
    if (!entry) continue;

    const position = m.index ?? 0;
    const nearby = hasNearbyContext(text, position);

    if (entry.isCommonWord) {
      // AMBIGUOUS: a bare mention is REJECTED outright, not stored weakly.
      //
      // Every one-character symbol lands here, plus the hand-reviewed set (AI,
      // ON, IT). "THIS IS A GREAT STOCK" must not associate Agilent, and no
      // amount of surrounding vocabulary changes that — a capital letter in
      // prose is not evidence about a security. The author has to say so:
      // `$A` (the cashtag branch above) or the company name (the alias branch
      // below) both still work.
      //
      // Dropping rather than recording at low confidence is deliberate: a
      // stored-but-hidden row still has to be reasoned about by every consumer
      // and still shows up as an "association" in the data.
      continue;
    }


    offer({
      symbol,
      confidence: nearby ? CONFIDENCE.symbolWithContext : CONFIDENCE.symbol,
      source: "symbol",
      matchedText: m[0],
      position,
    });
  }

  // 3. Company names and nicknames.
  const lower = lowerAll;
  for (const entry of catalog.aliases.values()) {
    const position = indexOfWord(lower, entry.alias);
    if (position < 0) continue;

    if (entry.requiresContext) {
      // "I ate an apple" — the alias is present but nothing says this is about
      // a security, so no association is recorded at all. Storing it at low
      // confidence would fill the table with fruit.
      //
      // The phrase check is what stops "Price Target" becoming Target Corp.
      // It is financial text containing a company name, so no context test can
      // separate the two; the phrase itself has to be recognized.
      const ok =
        hasAdjacentSecurityNoun(text, position, entry.alias.length, ALIAS_CONTEXT_WORDS) &&
        !insideBlockedPhrase(lower, position, entry.alias.length);
      if (!ok) continue;
    }

    offer({
      symbol: entry.symbol,
      confidence: entry.requiresContext ? CONFIDENCE.aliasWithContext : CONFIDENCE.alias,
      source: "alias",
      matchedText: text.slice(position, position + entry.alias.length),
      position,
    });
  }

  return [...best.values()].sort(compareMatches);
}

/** Whole-word `indexOf`, so "meta" does not match "metabolism". */
function indexOfWord(haystack: string, needle: string): number {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    const before = at === 0 ? " " : haystack[at - 1]!;
    const afterAt = at + needle.length;
    const after = afterAt >= haystack.length ? " " : haystack[afterAt]!;
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return at;
    from = at + 1;
  }
}

/** Cashtag first, then first appearance, then confidence. */
function compareMatches(a: TickerMatch, b: TickerMatch): number {
  const cash = Number(b.source === "cashtag") - Number(a.source === "cashtag");
  if (cash !== 0) return cash;
  if (a.position !== b.position) return a.position - b.position;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.symbol.localeCompare(b.symbol);
}

/** Extract across several fields, treating them as one document. */
export function extractFromParts(
  catalog: TickerCatalog,
  ...parts: Array<string | null | undefined>
): TickerMatch[] {
  const joined = parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n");
  return extractTickerMatches(joined, catalog);
}

/** The subset a reader may see — the projection stored in `tickers[]`. */
export function displayable(matches: TickerMatch[]): TickerMatch[] {
  return matches.filter((m) => m.confidence >= DISPLAY_THRESHOLD);
}
