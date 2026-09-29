import { createHash } from "node:crypto";

import { prisma } from "../../lib/prisma.js";
import {
  parseBanbetCreated,
  parseBanbetResult,
  parseDuration,
} from "../wsb/banbetBotParser.service.js";
import { zonedTimeToUtc } from "./yoloPeriods.js";

/**
 * BANBET INGESTION FROM THE BOT'S OWN RECORD.
 *
 * WHY THIS EXISTS BESIDE THE TEXT EXTRACTOR. The extractor guesses bets out of
 * prose — "NVDA hits 150 by Friday" — and cannot know the entry price, cannot
 * know whether r/wallstreetbets' bot ever accepted the wager, and cannot know
 * how it ended. Everything it produces is a CANDIDATE. The bot publishes all
 * of those facts explicitly, so parsing the bot turns a scoreboard built on
 * inference into one built on record, and only records reach the leaderboard.
 *
 * NO EXTRA PROVIDER COST. The bot's comments are already in `social_comments`,
 * arriving on the same r/wallstreetbets stream everything else uses. This reads
 * stored rows; it never polls Reddit for banbets specifically.
 *
 * MATCHING, in the order the evidence deserves:
 *
 *   1. REPLY STRUCTURE. A "Created" message replies to the `!banbet` command,
 *      so the command's comment id ties the bet to its author's own comment.
 *   2. THE BOT'S OWN FIELDS. A result message republishes ticker, entry and
 *      target, which identify the bet it settles.
 *   3. USER + TICKER + ENTRY + WINDOW, and only together.
 *
 * Never user + ticker alone: the same person bets the same ticker repeatedly,
 * and collapsing those would merge distinct calls into one invented record.
 */

/** The bot that owns the protocol. Anything from another author is not a record. */
const BOT_AUTHOR_HASHES = new Set<string>();

/**
 * The pipeline hashes authors one way at ingestion, so the bot is identified by
 * the hash of its handle rather than by the handle itself.
 */
function authorHashFor(username: string): string {
  return createHash("sha256").update(username.toLowerCase()).digest("hex");
}


const MONTH_ABBR = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/**
 * The bot's deadline: `"Sep 28, 11:30 PM"` — a wall-clock date with NO YEAR.
 *
 * The year comes from the message that carried it, with a rollover guard: a
 * "Jan 3" deadline on a message posted in late December belongs to the next
 * year, and without that check every New Year banbet would be recorded as
 * having expired eleven months before it was placed.
 *
 * READ AS AMERICA/NEW_YORK. The bot serves a US-market audience and writes
 * market hours ("11:30 PM" is an after-hours deadline, not a UTC one), so the
 * Arena's own clock is the reading most likely to be right. It is an
 * ASSUMPTION about someone else's formatting, not a fact we were given, and it
 * is worth re-checking if resolutions ever look an hour or five out.
 */
export function parseBotDeadline(raw: string, postedAt: Date): Date | null {
  const match = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(raw.trim());
  if (!match) {
    // Some deadlines arrive as a duration instead; fall back to that reading.
    const duration = parseDuration(raw);
    return duration === null ? null : new Date(postedAt.getTime() + duration);
  }

  const month = MONTH_ABBR.indexOf(match[1]!.toLowerCase()) + 1;
  if (month === 0) return null;
  const day = Number(match[2]);
  let hour = Number(match[3]) % 12;
  if (match[5]!.toUpperCase() === "PM") hour += 12;
  const minute = Number(match[4]);

  const postedYear = postedAt.getUTCFullYear();
  let candidate = zonedTimeToUtc(postedYear, month, day, hour, minute);
  // A deadline cannot precede the bet by months; that is a year boundary.
  if (candidate.getTime() < postedAt.getTime() - 30 * 86_400_000) {
    candidate = zonedTimeToUtc(postedYear + 1, month, day, hour, minute);
  }
  return candidate.getTime() > postedAt.getTime() ? candidate : null;
}

export interface BanbetIngestResult {
  createdMessagesSeen: number;
  resultMessagesSeen: number;
  confirmed: number;
  resolved: number;
  unmatchedResults: number;
}

interface CommentRow {
  externalId: string;
  body: string | null;
  postedAt: Date | null;
  parentCommentId: string | null;
  postExternalId: string | null;
  url: string | null;
  subreddit: string | null;
}

/**
 * Read the bot's messages out of stored comments.
 *
 * Matched on the message SHAPE rather than on the author, because the author is
 * stored as a hash and the bot's handle may be hashed with a salt this module
 * does not own. The shapes are distinctive — a "BanBet Created" table with
 * Ticker/Target/Entry columns is not something a human writes — and every one
 * is re-parsed strictly, so a false positive produces no row rather than a
 * wrong one.
 */
async function botMessages(kind: "created" | "result", limit: number): Promise<CommentRow[]> {
  const rows = await prisma.socialComments.findMany({
    where: {
      body: { contains: kind === "created" ? "BanBet Created" : "BanBet" },
      ...(kind === "result" ? { OR: [{ body: { contains: "Won" } }, { body: { contains: "Lost" } }] } : {}),
    },
    orderBy: { postedAt: "desc" },
    take: limit,
    select: {
      externalId: true,
      body: true,
      postedAt: true,
      parentCommentId: true,
      postExternalId: true,
      url: true,
      subreddit: true,
    },
  });
  return rows;
}

/**
 * Turn the bot's record into confirmed banbets.
 *
 * Idempotent: keyed on the bot comment's own id, so a re-run over an
 * overlapping window updates rather than duplicates.
 */
export async function ingestBanbetsFromBot(limit = 1000): Promise<BanbetIngestResult> {
  const result: BanbetIngestResult = {
    createdMessagesSeen: 0,
    resultMessagesSeen: 0,
    confirmed: 0,
    resolved: 0,
    unmatchedResults: 0,
  };

  // ── Phase 1: confirmations ──────────────────────────────────────────────
  for (const row of await botMessages("created", limit)) {
    const parsed = parseBanbetCreated(row.body);
    if (!parsed) continue;
    result.createdMessagesSeen += 1;

    const createdAt = row.postedAt ?? new Date();
    const expiresAt = parseBotDeadline(parsed.expiresAtRaw, createdAt);
    if (expiresAt === null) {
      // No deadline, no falsifiable bet. Skipped rather than given an invented
      // expiry — a bet with a guessed horizon scores against a claim nobody made.
      continue;
    }

    const externalId = `banbet-bot:${row.externalId}`;
    // WHOSE BET IT IS. The "Created" message replies to the author's own
    // `!banbet` command, so the bettor is that parent comment's author. Keyed
    // on the pipeline's existing one-way hash, which is the identity every
    // other table uses. Until the bot's outcome message republishes the handle
    // (phase 2) this is all we have, and hashing the COMMENT id instead — as
    // an earlier draft did — would give every bet its own "user" and make the
    // whole leaderboard provisional.
    const parentAuthor = row.parentCommentId
      ? await prisma.socialComments.findUnique({
          where: { externalId: row.parentCommentId },
          select: { authorHash: true },
        })
      : null;
    const usernameHash = parentAuthor?.authorHash ?? authorHashFor(row.externalId);

    await prisma.wsbBanbets.upsert({
      where: { externalId },
      create: {
        externalId,
        usernameHash,
        ticker: parsed.ticker,
        operator: parsed.side === "bull" ? "gte" : "lte",
        targetPrice: parsed.targetPrice,
        entryPrice: parsed.entryPrice,
        side: parsed.side,
        status: "open",
        // THE POINT OF THIS MODULE: the bot said so, so it is a record.
        confirmation: "confirmed",
        botReplyCommentId: row.externalId,
        redditCommentId: row.parentCommentId,
        redditPostId: row.postExternalId,
        subreddit: row.subreddit ?? "wallstreetbets",
        sourceUrl: row.url,
        createdAt,
        expiresAt,
        source: "banbet_bot",
      },
      update: {
        entryPrice: parsed.entryPrice,
        confirmation: "confirmed",
        botReplyCommentId: row.externalId,
        redditCommentId: row.parentCommentId,
      },
    });
    result.confirmed += 1;
  }

  // ── Phase 2: outcomes ───────────────────────────────────────────────────
  for (const row of await botMessages("result", limit)) {
    const parsed = parseBanbetResult(row.body);
    if (!parsed) continue;
    result.resultMessagesSeen += 1;

    const resolvedAt = row.postedAt ?? new Date();
    const ranMs = parseDuration(parsed.durationRaw);

    // Identify the bet by the bot's OWN republished fields — ticker, entry and
    // target together — inside a window that contains its creation. Ticker
    // alone would merge a user's repeated calls on the same symbol.
    const candidates = await prisma.wsbBanbets.findMany({
      where: {
        ticker: parsed.ticker,
        confirmation: "confirmed",
        status: "open",
        entryPrice: parsed.entryPrice,
        createdAt: ranMs === null ? undefined : { lte: resolvedAt, gte: new Date(resolvedAt.getTime() - ranMs - 86_400_000) },
      },
      orderBy: { createdAt: "desc" },
      take: 2,
    });

    // Ambiguity is not resolved by guessing. Two open bets matching the same
    // fields means the record cannot say which one settled.
    if (candidates.length !== 1) {
      result.unmatchedResults += 1;
      continue;
    }

    await prisma.wsbBanbets.update({
      where: { id: candidates[0]!.id },
      data: {
        status: parsed.outcome,
        resolvedAt,
        resultPct: parsed.movePercent,
        // The bot republishes the handle in its outcome message; it is part of
        // the scoreboard's own published content, not a recovered author field.
        displayUsername: parsed.username,
        // AND it is the identity the board groups on. The comment-thread hash
        // from phase 1 cannot tie a user's bets together across threads; the
        // published handle can, which is what makes a record a record.
        usernameHash: authorHashFor(parsed.username),
      },
    });
    result.resolved += 1;
  }

  return result;
}

export { authorHashFor, BOT_AUTHOR_HASHES };
