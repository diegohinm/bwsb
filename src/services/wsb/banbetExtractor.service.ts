import { extractTickers } from "../social/tickerExtractor.service.js";
import type { BanbetOperator, BanbetSide } from "./wsb.types.js";
import type { SocialPostItem } from "../social/socialData.types.js";

/**
 * BANBET EXTRACTION — worker-side only.
 *
 * A banbet is a falsifiable public call: a ticker, a price, a direction and a
 * deadline. All four must be present in the text or nothing is extracted —
 * "NVDA is going to rip" is an opinion, not a bet, and this module must not
 * turn opinions into a scoreboard.
 *
 * Identity stays anonymized: the pipeline only ever sees `authorHash`, so
 * `displayUsername` is null and the read layer renders an anonymous label. No
 * Reddit handle is stored by this path.
 */

export interface ExtractedBanbet {
  externalId: string;
  usernameHash: string;
  ticker: string;
  operator: BanbetOperator;
  targetPrice: number;
  side: BanbetSide;
  createdAt: Date;
  expiresAt: Date;
  subreddit: string;
  sourceUrl: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How long the bet runs when the author names a horizon instead of a date. */
const HORIZON_DAYS: Record<string, number> = {
  eod: 0,
  today: 0,
  tomorrow: 1,
  eow: 5,
  "end of week": 5,
  "next week": 7,
  eom: 30,
  "end of month": 30,
  eoy: 365,
  "end of year": 365,
};

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Directional phrasing. Anything reaching/exceeding a price is a `gte` bull
 * call; anything falling to/below one is a `lte` bear call.
 */
const BULL_VERBS = String.raw`(?:hits?|hitting|reach(?:es|ing)?|tops?|breaks?|goes?\s+to|to|above|over|>=?|≥)`;
const BEAR_VERBS = String.raw`(?:drops?\s+to|falls?\s+to|dips?\s+to|below|under|<=?|≤)`;

/**
 * The `$` is CAPTURED, not merely allowed. Testing the whole match for a "$"
 * would be satisfied by the price ("PATH ... $100"), which let arbitrary words
 * through as tickers. The lookbehind keeps the symbol from starting mid-word,
 * which is what turned "biLLION" into a holding in LLION.
 */
const TICKER = String.raw`(?<![A-Za-z0-9.$])(\$?)([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b`;
const PRICE = String.raw`\$?(\d{1,7}(?:[.,]\d{1,2})?)`;

const BULL_RE = new RegExp(`${TICKER}\\s+${BULL_VERBS}\\s+${PRICE}`, "gi");
const BEAR_RE = new RegExp(`${TICKER}\\s+${BEAR_VERBS}\\s+${PRICE}`, "gi");

/**
 * Same rule as the position extractor: a bare word is only a ticker if the
 * product's ticker universe already recognizes it in this item. Without that
 * gate "we go to 1000" becomes a bet on WE.
 */
function knownSymbols(item: SocialPostItem, text: string): Set<string> {
  return new Set([...item.tickers.map((t) => t.toUpperCase()), ...extractTickers(text)]);
}

const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const US_DATE_RE = /\bby\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i;
const MONTH_DAY_RE = new RegExp(
  String.raw`\bby\s+(${MONTHS.join("|")})\s+(\d{1,2})\b`,
  "i",
);
const IN_N_RE = /\bin\s+(\d{1,3})\s*(day|days|week|weeks|month|months)\b/i;
const HORIZON_RE = new RegExp(
  String.raw`\b(?:by\s+)?(${Object.keys(HORIZON_DAYS).join("|")})\b`,
  "i",
);

function atUtcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59),
  );
}

/**
 * Resolve the deadline stated in the text, relative to when it was written.
 * Returns null when no deadline is stated — which disqualifies the call.
 */
export function parseDeadline(text: string, createdAt: Date): Date | null {
  const iso = ISO_DATE_RE.exec(text);
  if (iso) {
    return atUtcMidnight(new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))));
  }

  const us = US_DATE_RE.exec(text);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = us[3]
        ? us[3].length === 2
          ? 2000 + Number(us[3])
          : Number(us[3])
        : createdAt.getUTCFullYear();
      // A bare month/day that already passed means next year.
      if (!us[3] && Date.UTC(year, month - 1, day) < createdAt.getTime()) year += 1;
      return atUtcMidnight(new Date(Date.UTC(year, month - 1, day)));
    }
  }

  const monthDay = MONTH_DAY_RE.exec(text);
  if (monthDay) {
    const month = MONTHS.indexOf(monthDay[1].toLowerCase());
    const day = Number(monthDay[2]);
    let year = createdAt.getUTCFullYear();
    if (Date.UTC(year, month, day) < createdAt.getTime()) year += 1;
    return atUtcMidnight(new Date(Date.UTC(year, month, day)));
  }

  const inN = IN_N_RE.exec(text);
  if (inN) {
    const n = Number(inN[1]);
    const unit = inN[2].toLowerCase();
    const days = unit.startsWith("week") ? n * 7 : unit.startsWith("month") ? n * 30 : n;
    if (days > 0 && days <= 365 * 3) {
      return atUtcMidnight(new Date(createdAt.getTime() + days * MS_PER_DAY));
    }
  }

  const horizon = HORIZON_RE.exec(text);
  if (horizon) {
    const days = HORIZON_DAYS[horizon[1].toLowerCase()];
    if (days !== undefined) {
      return atUtcMidnight(new Date(createdAt.getTime() + days * MS_PER_DAY));
    }
  }

  return null;
}

function cleanTicker(raw: string): string {
  return raw.replace(/^\$/, "").toUpperCase();
}

/**
 * Extract every banbet stated in one item.
 *
 * The id is derived from the item plus the terms of the bet, so re-ingesting
 * the same post upserts the same row instead of creating a duplicate.
 */
export function extractBanbets(item: SocialPostItem): ExtractedBanbet[] {
  const author = item.authorHash?.trim();
  if (!author) return [];

  const text = `${item.title ?? ""} ${item.text ?? ""}`.trim();
  if (!text) return [];

  const createdAt = new Date(item.createdAt);
  if (Number.isNaN(createdAt.getTime())) return [];

  const expiresAt = parseDeadline(text, createdAt);
  // No deadline, no bet: an undated price target can never resolve.
  if (!expiresAt || expiresAt.getTime() <= createdAt.getTime()) return [];

  const out: ExtractedBanbet[] = [];
  const seen = new Set<string>();
  const known = knownSymbols(item, text);

  for (const [re, operator, side] of [
    [BULL_RE, "gte", "bull"],
    [BEAR_RE, "lte", "bear"],
  ] as const) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const hadCashtag = m[1] === "$";
      const ticker = cleanTicker(m[2]);
      // A cashtag is self-declaring; a bare word must be a recognized symbol.
      if (!hadCashtag && !known.has(ticker)) continue;
      // One-letter symbols are real (F, K) but indistinguishable from prose
      // without a cashtag, so they need one.
      if (!hadCashtag && ticker.length < 2) continue;

      const targetPrice = Number(m[3].replace(/,/g, ""));
      if (!Number.isFinite(targetPrice) || targetPrice <= 0) continue;

      const key = `${ticker}:${operator}:${targetPrice}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        externalId: `${item.id}:${key}`,
        usernameHash: author,
        ticker,
        operator,
        targetPrice,
        side,
        createdAt,
        expiresAt,
        subreddit: item.subreddit,
        sourceUrl: item.url ?? null,
      });
    }
  }

  return out;
}

export function extractBanbetsFromItems(items: SocialPostItem[]): ExtractedBanbet[] {
  return items.flatMap(extractBanbets);
}

/**
 * Decide the outcome of a due bet against the price at (or nearest to) its
 * deadline.
 *
 * `resultPct` is the distance from the target, signed toward the bettor: +12
 * means the price cleared a bull target by 12%, -29.3 that it fell 29.3% short.
 * A bet with no usable price stays unresolved — the caller expires it rather
 * than inventing a verdict.
 */
export function resolveOutcome(
  bet: { operator: BanbetOperator; targetPrice: number },
  price: number | null,
): { status: "won" | "lost"; resultPct: number } | null {
  if (price === null || !Number.isFinite(price) || bet.targetPrice <= 0) return null;
  const won = bet.operator === "gte" ? price >= bet.targetPrice : price <= bet.targetPrice;
  const rawPct = ((price - bet.targetPrice) / bet.targetPrice) * 100;
  // For a bear call, being BELOW the target is the win, so the sign flips.
  const signed = bet.operator === "gte" ? rawPct : -rawPct;
  return { status: won ? "won" : "lost", resultPct: Math.round(signed * 10) / 10 };
}
