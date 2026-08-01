import { classifyDuration } from "./optionDuration.service.js";
import { extractTickers } from "../social/tickerExtractor.service.js";
import type {
  DurationBucket,
  OptionType,
  VerificationLevel,
} from "./wsb.types.js";
import type { SocialPostItem } from "../social/socialData.types.js";

/**
 * POSITION EXTRACTION — worker-side only.
 *
 * Turns already-ingested social content into declared positions. The hard rule
 * from the product spec: **a ticker mention is not a position**. "NVDA to the
 * moon" contributes nothing here; only text that states WHAT was bought, in a
 * size or a contract, produces a row.
 *
 * Three evidence tiers, in descending order of what we actually know:
 *
 *   screenshot  the item is a broker screenshot AND a position parsed out of it
 *   extracted   an explicit option contract, or an explicit share count
 *   text_only   a plain declared long/short with no size ("I'm long MU")
 *
 * `verified` is reserved for positions confirmed by the bet-verification
 * pipeline; nothing in this module may award it. text_only rows count a HOLDER
 * but never contribute size or exposure — that keeps the money figures backed by
 * a stated quantity while still reflecting who is positioned.
 *
 * Everything here is deliberately conservative: a missed position is a smaller
 * number, an invented one is a lie.
 */

/** An option position as declared by one author in one item. */
export interface ExtractedOptionPosition {
  kind: "option";
  authorHash: string;
  subreddit: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  /** UTC midnight of the expiration date. */
  expiration: Date;
  dte: number;
  durationBucket: DurationBucket;
  /** Contracts. 0 when the author declared a contract without a size. */
  contracts: number;
  bullish: boolean;
  verificationLevel: VerificationLevel;
}

/** A stock position as declared by one author in one item. */
export interface ExtractedStockPosition {
  kind: "stock";
  authorHash: string;
  subreddit: string;
  ticker: string;
  /** Shares. 0 for a text_only declaration. */
  shares: number;
  bullish: boolean;
  verificationLevel: VerificationLevel;
}

export type ExtractedPosition = ExtractedOptionPosition | ExtractedStockPosition;

/**
 * A candidate symbol only counts when the product's ticker universe recognizes
 * it. The alternative — accepting any 1-5 letter word next to a number — turns
 * "100 shares of the float" into holdings in THE and FLOAT, which is exactly the
 * kind of invented position this module exists to prevent.
 *
 * `item.tickers` is the upstream extractor's own verdict for that item, so
 * deferring to it keeps ONE ticker universe across the whole product rather than
 * a second, looser one here.
 */
function knownSymbols(item: SocialPostItem): Set<string> {
  return new Set([
    ...item.tickers.map((t) => t.toUpperCase()),
    ...extractTickers(itemText(item)),
  ]);
}

/**
 * Ticker: 1-5 letters, optionally `$`-prefixed, optionally `BRK.B` style.
 *
 * The `$` is CAPTURED so the cashtag test looks at the symbol itself. Testing
 * the whole match instead is satisfied by any other dollar amount in it, which
 * is how arbitrary words slipped through as tickers. The lookbehind stops a
 * symbol from starting mid-word.
 */
const TICKER = String.raw`(?<![A-Za-z0-9.$])(\$?)([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b`;

/**
 * `NVDA $215c`, `NVDA 215 CALL`, `$SPY 735p`, `MU $350 C`.
 * The strike must be adjacent to the type letter, which is what separates a
 * contract from "NVDA up 215 points".
 */
const OPTION_RE = new RegExp(
  TICKER + String.raw`\s*\$?(\d{1,6}(?:\.\d{1,2})?)\s*(c|p)(?:alls?|uts?)?\b`,
  "gi",
);

/** `100 shares of NVDA`, `250 shares NVDA`, `bought 50 shares of $MU`. */
const SHARES_RE = new RegExp(
  String.raw`(\d[\d,]{0,9})\s*(?:shares?|sh)\s*(?:of\s+)?` + TICKER,
  "gi",
);

/** `long 100 NVDA`, `short 50 $SPY` — verb, size, ticker. */
const SIZED_SIDE_RE = new RegExp(
  String.raw`\b(long|short|bought|sold|holding|hold)\s+(\d[\d,]{0,9})\s+` + TICKER,
  "gi",
);

/** `I'm long MU`, `going long on $NVDA` — a side with no size. */
const UNSIZED_SIDE_RE = new RegExp(
  String.raw`\b(long|short)\s+(?:on\s+)?` + TICKER + String.raw`\b`,
  "gi",
);

/** `10x`, `x10`, `10 contracts` sitting next to a contract. */
const CONTRACTS_BEFORE_RE = /(\d{1,5})\s*(?:x|contracts?|lots?)\s*$/i;
const CONTRACTS_AFTER_RE = /^\s*(?:x\s*)?(\d{1,5})\s*(?:contracts?|lots?)\b/i;

/** ISO `2027-03-19`, US `3/19/27`, `3/19`. */
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const US_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

function cleanTicker(raw: string): string {
  return raw.replace(/^\$/, "").toUpperCase();
}

/**
 * A cashtag is self-declaring, so `$XYZ` is accepted even for a symbol the
 * allowlist has not caught up with. A bare word must be in the known set.
 */
function isPlausibleTicker(raw: string, hadCashtag: boolean, known: Set<string>): boolean {
  const t = cleanTicker(raw);
  if (t.length < 1 || t.length > 6) return false;
  return hadCashtag || known.has(t);
}

/**
 * Resolve a written expiration to a UTC date. A 2-digit year is 20xx; a date
 * with no year is the next occurrence of that month/day, so "3/19" written in
 * December means next March, not a date ten months in the past.
 */
export function parseExpiration(text: string, now: Date = new Date()): Date | null {
  const iso = ISO_DATE_RE.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const us = US_DATE_RE.exec(text);
  if (!us) return null;
  const [, mm, dd, yy] = us;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let year: number;
  if (yy) {
    year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
  } else {
    year = now.getUTCFullYear();
    const candidate = Date.UTC(year, month - 1, day);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (candidate < today) year += 1;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Contracts declared immediately before or after the matched contract text. */
function contractsAround(text: string, start: number, end: number): number {
  const before = CONTRACTS_BEFORE_RE.exec(text.slice(Math.max(0, start - 24), start));
  if (before) return Number(before[1]);
  const after = CONTRACTS_AFTER_RE.exec(text.slice(end, end + 24));
  if (after) return Number(after[1]);
  return 0;
}

function itemText(item: SocialPostItem): string {
  return `${item.title ?? ""} ${item.text ?? ""}`.trim();
}

/**
 * A position is only attributable to a person. Items whose author was not
 * anonymized upstream are skipped rather than merged into a shared bucket,
 * which would inflate `holders` for the same unknown author.
 */
function authorOf(item: SocialPostItem): string | null {
  return item.authorHash && item.authorHash.trim() ? item.authorHash : null;
}

/**
 * Extract every position declared in one item.
 *
 * `now` is injected so classification is deterministic in tests and so a whole
 * ingestion run shares one clock.
 */
export function extractPositions(
  item: SocialPostItem,
  now: Date = new Date(),
): ExtractedPosition[] {
  const author = authorOf(item);
  if (!author) return [];

  const text = itemText(item);
  if (!text) return [];

  const known = knownSymbols(item);
  const level: VerificationLevel = item.isScreenshot ? "screenshot" : "extracted";
  const out: ExtractedPosition[] = [];
  const seen = new Set<string>();

  // ── Options ────────────────────────────────────────────────────────────────
  // The expiration is read from the whole item: WSB writes "MU 350c expiring
  // 3/19/27" and "3/19/27 MU 350c" with equal enthusiasm.
  const expiration = parseExpiration(text, now);

  OPTION_RE.lastIndex = 0;
  for (const m of text.matchAll(OPTION_RE)) {
    const [full, cashtag, rawTicker, rawStrike, typeLetter] = m;
    if (!isPlausibleTicker(rawTicker, cashtag === "$", known)) continue;

    const strike = Number(rawStrike);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    // Without an expiration a contract cannot be bucketed by DTE, and this
    // table is keyed on expiration — so it is not stored as an option position.
    if (!expiration) continue;

    const duration = classifyDuration(expiration, now);
    if (!duration) continue; // already expired — not a live position

    const underlying = cleanTicker(rawTicker);
    const optionType: OptionType = typeLetter.toLowerCase() === "c" ? "call" : "put";
    const key = `o:${underlying}:${optionType}:${strike}:${expiration.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      kind: "option",
      authorHash: author,
      subreddit: item.subreddit,
      underlying,
      optionType,
      strike,
      expiration,
      dte: duration.dte,
      durationBucket: duration.bucket,
      contracts: contractsAround(text, m.index ?? 0, (m.index ?? 0) + full.length),
      // The structure decides direction: a put is a bearish position however
      // upbeat the post reads. A call defers to the author's stance, so
      // "selling my NVDA calls" from a bearish post isn't counted as bullish.
      bullish: optionType === "call" && item.stance !== "bearish",
      verificationLevel: level,
    });
  }

  // ── Stocks with an explicit size ───────────────────────────────────────────
  for (const re of [SHARES_RE, SIZED_SIDE_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // SHARES_RE: [, qty, cashtag, ticker].
      // SIZED_SIDE_RE: [, verb, qty, cashtag, ticker].
      const groups = m.slice(1);
      const rawTicker = groups[groups.length - 1];
      const cashtag = groups[groups.length - 2];
      const rawQty = groups[groups.length - 3];
      const verb = groups.length === 4 ? groups[0].toLowerCase() : null;

      if (!isPlausibleTicker(rawTicker, cashtag === "$", known)) continue;
      const shares = Number(String(rawQty).replace(/,/g, ""));
      if (!Number.isFinite(shares) || shares <= 0) continue;

      const ticker = cleanTicker(rawTicker);
      const key = `s:${ticker}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isShort = verb === "short" || verb === "sold";
      out.push({
        kind: "stock",
        authorHash: author,
        subreddit: item.subreddit,
        ticker,
        shares,
        bullish: !isShort && item.stance !== "bearish",
        verificationLevel: level,
      });
    }
  }

  // ── Declared side without a size ───────────────────────────────────────────
  // Recorded as text_only: it tells us someone is positioned, not how much.
  UNSIZED_SIDE_RE.lastIndex = 0;
  for (const m of text.matchAll(UNSIZED_SIDE_RE)) {
    const [, verb, cashtag, rawTicker] = m;
    if (!isPlausibleTicker(rawTicker, cashtag === "$", known)) continue;
    const ticker = cleanTicker(rawTicker);
    if (seen.has(`s:${ticker}`)) continue;
    seen.add(`s:${ticker}`);

    out.push({
      kind: "stock",
      authorHash: author,
      subreddit: item.subreddit,
      ticker,
      shares: 0,
      bullish: verb.toLowerCase() === "long",
      verificationLevel: "text_only",
    });
  }

  return out;
}

/** Extract across a whole ingestion window. */
export function extractPositionsFromItems(
  items: SocialPostItem[],
  now: Date = new Date(),
): ExtractedPosition[] {
  return items.flatMap((item) => extractPositions(item, now));
}
