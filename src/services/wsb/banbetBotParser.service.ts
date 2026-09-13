/**
 * THE BANBET PROTOCOL, AS r/wallstreetbets ACTUALLY RUNS IT.
 *
 * A banbet is not a phrase someone wrote — it is a COMMAND to a bot, and the
 * bot's replies are the authoritative record of what was wagered and how it
 * resolved. Four message shapes make up the whole protocol, all posted by
 * `verified-trader`:
 *
 *   1. the user's command      `!banbet NBIS -10% 5d`
 *   2. the bot's confirmation  **BanBet Created** … | Ticker | Target | Entry | …
 *   3. the bot's outcome       **BanBet Won/Lost** — /u/name … | Entry → Target | …
 *   4. a status reply          **No Active BanBet** …
 *
 * WHY THIS REPLACES INFERRING BETS FROM PROSE. The extractor this sits beside
 * reads free text — "NVDA hits 150 by Friday" — and has to guess whether a
 * sentence was a wager at all. That guess is unfalsifiable, it cannot know the
 * entry price, it has no outcome, and it produced seven rows. The bot publishes
 * every one of those facts explicitly, so parsing IT turns a scoreboard built on
 * inference into one built on record.
 *
 * IDENTITY, AND WHY IT IS NOT A DE-ANONYMIZATION. This codebase never stores
 * Reddit usernames: authors are hashed one-way at ingestion and that stays true.
 * A banbet's username is different in kind — the bettor invoked a public bot,
 * and the bot REPUBLISHES their handle in its outcome comment ("— /u/Cosmic64X
 * (0W - 4L, 0%)"). The name is part of the scoreboard's own published content,
 * not something recovered from an author field, and a leaderboard of public
 * calls is the entire point of the feature. So it is read from the message
 * text, and the hashing elsewhere is left exactly as it is.
 *
 * EVERY PARSER HERE IS PURE AND TOTAL: it returns null rather than throwing,
 * and never half-fills a record. A malformed message must produce no banbet at
 * all, because a bet with a guessed price is worse than a bet nobody counted.
 */

/** The bot that owns the protocol. Messages from anyone else are not records. */
export const BANBET_BOT_AUTHOR = "verified-trader";

export type BanbetSideParsed = "bull" | "bear";

/** `!banbet NBIS -10% 5d` — the user's wager, before the bot priced it. */
export interface ParsedBanbetCommand {
  ticker: string;
  /** An absolute price target, when the author named one. */
  targetPrice: number | null;
  /** A percentage move, when the author named one instead. Signed. */
  targetPercent: number | null;
  /** The requested horizon in milliseconds, when parseable. */
  durationMs: number | null;
  /** The raw duration token, kept for diagnostics on a parse failure. */
  rawDuration: string | null;
}

/** The bot's confirmation: the authoritative terms of the bet. */
export interface ParsedBanbetCreated {
  ticker: string;
  targetPrice: number;
  /** The price when the bet was opened. The denominator of every return. */
  entryPrice: number;
  /** Target move from entry, as the bot computed it. Signed. */
  movePercent: number;
  side: BanbetSideParsed;
  /** The bot's deadline, as written. Parsed against the message's own date. */
  expiresAtRaw: string;
}

/** The bot's outcome message. */
export interface ParsedBanbetResult {
  /** The bettor's REAL Reddit handle, as the bot published it. */
  username: string;
  ticker: string;
  entryPrice: number;
  targetPrice: number;
  movePercent: number;
  side: BanbetSideParsed;
  /** `won` | `lost` | `expired`, exactly as the bot declared it. */
  outcome: "won" | "lost" | "expired";
  /** How long the bet ran, as written ("4w 2d", "4h 59m"). */
  durationRaw: string;
  /** The bot's running tally for this user at resolution time. */
  record: { wins: number; losses: number; winRatePercent: number } | null;
}

const DURATION_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * `4w 2d`, `5d`, `4h 59m`, `2W` → milliseconds.
 *
 * Multi-unit and case-insensitive because all three appear in real commands and
 * in the bot's own `Time` column. Returns null when nothing parsed, rather than
 * zero — "no horizon given" and "a zero-length bet" are different, and only one
 * of them is a bet.
 */
export function parseDuration(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let total = 0;
  let matched = false;
  for (const m of raw.matchAll(/(\d+(?:\.\d+)?)\s*([mhdw])\b/gi)) {
    const value = Number(m[1]);
    const unit = DURATION_UNIT_MS[(m[2] ?? "").toLowerCase()];
    if (!Number.isFinite(value) || unit === undefined) continue;
    total += value * unit;
    matched = true;
  }
  return matched ? total : null;
}

/** `$1,548.17` → 1548.17. Null on anything that is not a number. */
function money(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function percent(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/[%+\s]/g, "").replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * The user's command.
 *
 * BOTH TARGET FORMS ARE REAL and neither can be dropped: `!banbet SKHY 160 3w`
 * names an absolute price, `!banbet NBIS -10% 5d` names a move. The bot resolves
 * either into an absolute target, so this only has to record which was asked
 * for — the authoritative number comes from the confirmation.
 *
 * A bare `!banbet` with no arguments is a real thing people post (it is how the
 * bot is asked for a status), and it is NOT a bet. It parses to null.
 */
export function parseBanbetCommand(body: string | null | undefined): ParsedBanbetCommand | null {
  if (!body) return null;
  const match = /^\s*!banbet\s+(.+)$/i.exec(body.trim());
  if (!match) return null;

  const rest = (match[1] ?? "").trim();
  // Ticker first, then the target, then whatever horizon is left.
  const parts = rest.split(/\s+/).filter(Boolean);
  const rawTicker = parts[0];
  if (!rawTicker) return null;

  const ticker = rawTicker.replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(ticker)) return null;

  const targetToken = parts[1] ?? null;
  const durationToken = parts.slice(2).join(" ") || null;

  let targetPrice: number | null = null;
  let targetPercent: number | null = null;

  if (targetToken) {
    if (/%/.test(targetToken)) {
      targetPercent = percent(targetToken.replace(/^\+/, ""));
      // A percentage keeps its sign: -10% is a bear call, +10% a bull one.
      if (targetPercent !== null && /^-/.test(targetToken)) {
        targetPercent = -Math.abs(targetPercent);
      }
    } else {
      targetPrice = money(targetToken);
    }
  }

  // Neither a price nor a move means no wager was actually stated.
  if (targetPrice === null && targetPercent === null) return null;

  return {
    ticker,
    targetPrice,
    targetPercent,
    durationMs: parseDuration(durationToken),
    rawDuration: durationToken,
  };
}

/** The arrow the bot uses for direction. ▲ is a bull call, ▼ a bear one. */
function sideFromArrow(text: string): BanbetSideParsed | null {
  if (text.includes("▲")) return "bull";
  if (text.includes("▼")) return "bear";
  return null;
}

/**
 * Direction, decided by PRICES rather than by sentiment.
 *
 * The arrow is preferred because the bot states it outright; the comparison is
 * the fallback and means the same thing. Sentiment is deliberately not
 * consulted anywhere: a bearish-sounding rant attached to a bet that the price
 * RISES is still a bull call, and the wager is what is being scored.
 */
function resolveSide(
  arrowText: string,
  entryPrice: number,
  targetPrice: number,
): BanbetSideParsed {
  return sideFromArrow(arrowText) ?? (targetPrice >= entryPrice ? "bull" : "bear");
}

/**
 * `**BanBet Created** ▼ | **Record:** 2W - 1L`
 * `| **NBIS** | $202.10 (below) | $224.55 | -10.0% | Sep 17, 9:26 PM |`
 */
export function parseBanbetCreated(body: string | null | undefined): ParsedBanbetCreated | null {
  if (!body || !/\*\*BanBet Created\*\*/i.test(body)) return null;

  // The data row is the one naming a bolded ticker; the header and the
  // alignment row are skipped by that requirement alone.
  const row = /\|\s*\*\*([A-Za-z.]{1,6})\*\*\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(body);
  if (!row) return null;

  const ticker = (row[1] ?? "").toUpperCase();
  const targetPrice = money((row[2] ?? "").replace(/\((?:above|below)\)/i, ""));
  const entryPrice = money(row[3]);
  const movePercent = percent(row[4]);
  const expiresAtRaw = (row[5] ?? "").trim();

  if (targetPrice === null || entryPrice === null || movePercent === null) return null;
  if (entryPrice <= 0) return null;

  // The header carries the arrow for a Created message, not the row.
  const header = body.slice(0, body.indexOf("\n") + 1 || undefined);

  return {
    ticker,
    targetPrice,
    entryPrice,
    movePercent,
    side: resolveSide(header, entryPrice, targetPrice),
    expiresAtRaw,
  };
}

/**
 * `**BanBet Lost** — /u/Cosmic64X (0W - 4L, 0%)`
 * `| **SNDK** ▲ | $1548.17 → $2000.00 | +29.2% | 4w 2d | Lost |`
 */
export function parseBanbetResult(body: string | null | undefined): ParsedBanbetResult | null {
  if (!body) return null;

  const header = /\*\*BanBet\s+(Won|Lost|Expired)\*\*\s*[—-]\s*\/u\/([A-Za-z0-9_\-]+)/i.exec(body);
  if (!header) return null;

  const outcome = (header[1] ?? "").toLowerCase() as ParsedBanbetResult["outcome"];
  const username = header[2] ?? "";

  const row =
    /\|\s*\*\*([A-Za-z.]{1,6})\*\*\s*([▲▼]?)\s*\|\s*([^|]*?)→([^|]*?)\|([^|]*)\|([^|]*)\|/.exec(
      body,
    );
  if (!row) return null;

  const ticker = (row[1] ?? "").toUpperCase();
  const entryPrice = money(row[3]);
  const targetPrice = money(row[4]);
  const movePercent = percent(row[5]);
  const durationRaw = (row[6] ?? "").trim();

  if (entryPrice === null || targetPrice === null || movePercent === null) return null;
  if (entryPrice <= 0) return null;

  // `(2W - 1L, 67%)` — the bot's own tally at resolution. Recorded because it is
  // an independent check on any leaderboard computed from stored rows: if the
  // two disagree, the ingestion missed bets rather than the bot being wrong.
  const tally = /\((\d+)\s*W\s*-\s*(\d+)\s*L,\s*(\d+(?:\.\d+)?)\s*%\)/i.exec(body);

  return {
    username,
    ticker,
    entryPrice,
    targetPrice,
    movePercent,
    side: resolveSide(row[2] ?? "", entryPrice, targetPrice),
    outcome,
    durationRaw,
    record: tally
      ? {
          wins: Number(tally[1]),
          losses: Number(tally[2]),
          winRatePercent: Number(tally[3]),
        }
      : null,
  };
}

/** `**No Active BanBet**` — a status reply, never a bet. */
export function isBanbetStatusMessage(body: string | null | undefined): boolean {
  return Boolean(body && /\*\*No Active BanBet\*\*/i.test(body));
}

/**
 * `**BanBet Error** — You already have an active banbet …`
 *
 * A refusal: the command was rejected and NO bet exists. Recognised explicitly
 * rather than left to fall through, because the ingestion counts anything it
 * cannot classify as a parse failure worth an operator's attention — and a
 * message the bot posts routinely would bury the failures that matter.
 */
export function isBanbetErrorMessage(body: string | null | undefined): boolean {
  return Boolean(body && /\*\*BanBet Error\*\*/i.test(body));
}

/**
 * A bot message that is deliberately NOT a bet.
 *
 * The distinction the ingestion needs: "recognised, and correctly produced
 * nothing" versus "did not understand". Only the second is a defect.
 */
export function isNonBetBotMessage(body: string | null | undefined): boolean {
  return isBanbetStatusMessage(body) || isBanbetErrorMessage(body);
}

/**
 * REALIZED RETURN for a resolved bet.
 *
 * WHAT THE BOT DOES AND DOES NOT PUBLISH. Its `Move` column is the TARGET move
 * — entry → target — not what the price actually did. For a WON bet those
 * coincide: the bet resolves because the target was reached, so the realized
 * move is the target move. For a LOST bet they do not, and the bot never states
 * the price at expiry, so the realized return is genuinely unknown from the
 * record alone.
 *
 * Returning null for a loss is therefore the honest answer, and the alternative
 * is worse than useless: inventing "-100%" or reusing the target move would put
 * a fabricated number into the leaderboard's average return, which is exactly
 * the statistic people would trust most.
 *
 * Sign convention follows the WAGER, not the price: a bear call that correctly
 * predicted a fall is a POSITIVE return for the bettor.
 */
export function realizedReturnPercent(
  outcome: ParsedBanbetResult["outcome"],
  movePercent: number,
): number | null {
  if (outcome !== "won") return null;
  return Math.abs(movePercent);
}
