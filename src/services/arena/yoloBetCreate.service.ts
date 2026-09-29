import { prisma } from "../../lib/prisma.js";
import { realizedVolatility } from "./realizedVolatility.service.js";
import { YOLO_SCORE_CONFIG } from "./yoloScore.config.js";
import {
  calculateYoloScore,
  directionFor,
  meetsMinimumTargetMove,
  type YoloScoreBreakdown,
} from "./yoloScore.service.js";

/**
 * PLACING A YOLOPULSE BET.
 *
 * Everything here exists to stop a bet being improved after the fact. The
 * failure mode is not a crash; it is a leaderboard that looks fine and is
 * quietly worthless because the winners edited their way there.
 *
 * FOUR RULES, each guarding a specific trick:
 *
 *   - The ENTRY PRICE comes from a fresh quote read HERE. Accepting one from
 *     the client would let a caller enter at yesterday's price knowing today's.
 *   - The SCORE is computed HERE. The frontend previews the same formula, but a
 *     preview is a courtesy; the stored number never comes from the request.
 *   - ONE ACTIVE BET PER TICKER, enforced by a partial unique index in the
 *     database. Holding "META to $900" and "META to $500" at once guarantees a
 *     winner whatever happens, which is not a prediction.
 *   - NOTHING IS EDITABLE afterwards. There is no update path for ticker,
 *     entry, target, direction or deadline — not a permission check, an absence
 *     of code.
 */

export type CreateBetFailure =
  | { ok: false; code: "unknown_ticker"; message: string }
  | { ok: false; code: "no_price"; message: string }
  | { ok: false; code: "stale_price"; message: string }
  | { ok: false; code: "target_too_close"; message: string }
  | { ok: false; code: "deadline_too_soon"; message: string }
  | { ok: false; code: "deadline_too_far"; message: string }
  | { ok: false; code: "deadline_in_past"; message: string }
  | { ok: false; code: "duplicate_active"; message: string }
  | { ok: false; code: "too_many_active"; message: string }
  | { ok: false; code: "no_volatility"; message: string };

export interface CreatedBet {
  ok: true;
  id: string;
  ticker: string;
  direction: "up" | "down";
  entryPrice: number;
  entryTimestamp: string;
  targetPrice: number;
  expiresAt: string;
  volatilityAtEntry: number;
  score: YoloScoreBreakdown;
}

export type CreateBetResult = CreatedBet | CreateBetFailure;

const fail = (code: CreateBetFailure["code"], message: string): CreateBetFailure =>
  ({ ok: false, code, message }) as CreateBetFailure;

export interface QuoteSnapshot {
  price: number;
  /** When the QUOTE was observed — not when it was read from the table. */
  observedAt: Date;
}

/**
 * The latest stored quote for a ticker.
 *
 * Stored, not live: the creation path must never make a metered provider call,
 * or placing a bet becomes a way to spend the product's budget. The staleness
 * check below is what keeps that honest.
 */
export async function latestQuote(ticker: string): Promise<QuoteSnapshot | null> {
  const row = await prisma.marketQuotesLatest.findUnique({
    where: { symbol: ticker.toUpperCase() },
    select: { price: true, observedAt: true, updatedAt: true },
  });
  if (!row || row.price === null) return null;
  const price = Number(row.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  // `observedAt` is when the PROVIDER saw the price; `updatedAt` is only when
  // we wrote the row. Falling back to the write time would make a stale quote
  // look fresh every time the refresher touched it.
  return { price, observedAt: row.observedAt ?? row.updatedAt };
}

export interface CreateBetInput {
  userId: string;
  ticker: string;
  targetPrice: number;
  expiresAt: Date;
  now?: Date;
}

export async function createYoloBet(input: CreateBetInput): Promise<CreateBetResult> {
  const now = input.now ?? new Date();
  const ticker = input.ticker.trim().toUpperCase();

  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) {
    return fail("unknown_ticker", "That does not look like a ticker symbol.");
  }
  if (!Number.isFinite(input.targetPrice) || input.targetPrice <= 0) {
    return fail("target_too_close", "A target price must be a positive number.");
  }

  // ── The window ──────────────────────────────────────────────────────────
  const minutes = (input.expiresAt.getTime() - now.getTime()) / 60_000;
  if (minutes <= 0) return fail("deadline_in_past", "That deadline has already passed.");
  if (minutes < YOLO_SCORE_CONFIG.minDeadlineMinutes) {
    return fail(
      "deadline_too_soon",
      `A bet must run at least ${YOLO_SCORE_CONFIG.minDeadlineMinutes} minutes.`,
    );
  }
  if (minutes > YOLO_SCORE_CONFIG.maxDeadlineMinutes) {
    return fail(
      "deadline_too_far",
      `A bet may run at most ${Math.round(YOLO_SCORE_CONFIG.maxDeadlineMinutes / 1440)} days.`,
    );
  }

  // ── The entry price, read here and frozen ───────────────────────────────
  const quote = await latestQuote(ticker);
  if (!quote) {
    return fail("no_price", `No stored price for ${ticker} — it cannot be bet on yet.`);
  }

  const ageMinutes = (now.getTime() - quote.observedAt.getTime()) / 60_000;
  if (ageMinutes > YOLO_SCORE_CONFIG.maxEntryPriceAgeMinutes) {
    // A bet priced off a two-hour-old quote is a bet placed with hindsight.
    return fail(
      "stale_price",
      `The last ${ticker} price is ${Math.round(ageMinutes)} minutes old. Bets need a recent quote.`,
    );
  }

  if (!meetsMinimumTargetMove(quote.price, input.targetPrice)) {
    return fail(
      "target_too_close",
      `A target must be at least ${YOLO_SCORE_CONFIG.minTargetMovePercent}% from the current price.`,
    );
  }

  // ── Volatility, frozen at entry ─────────────────────────────────────────
  const vol = await realizedVolatility(ticker, now);
  if (!vol) {
    // No history, no difficulty, no score. Better to refuse the bet than to
    // record one that can never be scored honestly.
    return fail(
      "no_volatility",
      `Not enough price history for ${ticker} to measure how unusual that target is.`,
    );
  }

  // ── Anti-spam ───────────────────────────────────────────────────────────
  const activeCount = await prisma.yoloBets.count({
    where: { userId: input.userId, status: "active" },
  });
  if (activeCount >= YOLO_SCORE_CONFIG.maxActiveBetsPerUser) {
    return fail(
      "too_many_active",
      `You already hold ${activeCount} open bets. Resolve some before placing more.`,
    );
  }

  const direction = directionFor(quote.price, input.targetPrice);

  const score = calculateYoloScore({
    entryPrice: quote.price,
    targetPrice: input.targetPrice,
    createdAt: now,
    expiresAt: input.expiresAt,
    volatilityAtEntry: vol.volatility,
    outcome: "unresolved",
  });
  if (!score.scorable) {
    return fail("no_volatility", "That bet cannot be scored, so it cannot be placed.");
  }

  try {
    const created = await prisma.yoloBets.create({
      data: {
        userId: input.userId,
        ticker,
        direction,
        entryPrice: quote.price,
        entryTimestamp: now,
        marketDataTimestamp: quote.observedAt,
        targetPrice: input.targetPrice,
        expiresAt: input.expiresAt,
        status: "active",
        volatilityAtEntry: vol.volatility,
        targetMove: score.targetMove,
        expectedMove: score.expectedMove,
        difficulty: score.difficulty,
        rawScore: score.rawScore,
        // Zero until it resolves: an open bet has moved nobody's total.
        scoreDelta: 0,
        scoringVersion: score.scoringVersion,
      },
      select: { id: true },
    });

    return {
      ok: true,
      id: created.id,
      ticker,
      direction,
      entryPrice: quote.price,
      entryTimestamp: now.toISOString(),
      targetPrice: input.targetPrice,
      expiresAt: input.expiresAt.toISOString(),
      volatilityAtEntry: vol.volatility,
      score,
    };
  } catch (error) {
    // The partial unique index is the real guard against a contradictory pair;
    // two simultaneous requests would both pass a pre-check.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2002"
    ) {
      return fail(
        "duplicate_active",
        `You already have an open bet on ${ticker}. Wait for it to resolve.`,
      );
    }
    throw error;
  }
}

/**
 * A preview: the same numbers, without writing anything.
 *
 * The frontend calls this so "Estimated Difficulty 2.8x / Potential 214 pts"
 * on the Place Bet panel is the BACKEND's arithmetic rather than a second
 * implementation that can drift from it.
 */
export async function previewYoloBet(params: {
  ticker: string;
  targetPrice: number;
  expiresAt: Date;
  now?: Date;
}): Promise<
  | {
      ok: true;
      ticker: string;
      entryPrice: number;
      marketDataTimestamp: string;
      direction: "up" | "down";
      volatilityAtEntry: number;
      score: YoloScoreBreakdown;
    }
  | CreateBetFailure
> {
  const now = params.now ?? new Date();
  const ticker = params.ticker.trim().toUpperCase();

  const quote = await latestQuote(ticker);
  if (!quote) return fail("no_price", `No stored price for ${ticker}.`);

  const vol = await realizedVolatility(ticker, now);
  if (!vol) return fail("no_volatility", `Not enough price history for ${ticker}.`);

  const score = calculateYoloScore({
    entryPrice: quote.price,
    targetPrice: params.targetPrice,
    createdAt: now,
    expiresAt: params.expiresAt,
    volatilityAtEntry: vol.volatility,
    outcome: "unresolved",
  });
  if (!score.scorable) return fail("target_too_close", "That target cannot be scored.");

  return {
    ok: true,
    ticker,
    entryPrice: quote.price,
    marketDataTimestamp: quote.observedAt.toISOString(),
    direction: directionFor(quote.price, params.targetPrice),
    volatilityAtEntry: vol.volatility,
    score,
  };
}
