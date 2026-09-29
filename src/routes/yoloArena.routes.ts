import { Router } from "express";

import { asyncHandler } from "../lib/response.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { prisma } from "../lib/prisma.js";
import {
  isBetStatusFilter,
  isBetType,
  readArenaSummary,
  readYoloLeaderboard,
  type BetStatusFilter,
  type BetType,
} from "../services/arena/yoloLeaderboard.service.js";
import { isYoloPeriod, YOLO_PERIODS, type YoloPeriod } from "../services/arena/yoloPeriods.js";
import { createYoloBet, previewYoloBet } from "../services/arena/yoloBetCreate.service.js";
import { YOLO_SCORE_CONFIG, YOLO_SCORING_VERSION } from "../services/arena/yoloScore.config.js";

/**
 * YOLO ARENA — leaderboards (public) and bet placement (authenticated).
 *
 * The boards are the shop window and carry no auth: a logged-out visitor sees
 * every ranking. What needs a session is PARTICIPATION — placing a bet — and
 * there is deliberately no route here that edits one. Immutability is an
 * absence of code, not a permission check that could be misconfigured.
 *
 * Every read hits stored rows. Nothing on this router can reach a metered
 * provider, so a visitor refreshing the page cannot cost anything upstream.
 */

export const yoloArenaRouter = Router();

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Bad input falls back rather than 400-ing a public page. */
function readType(raw: unknown): BetType {
  const value = firstString(raw);
  return isBetType(value) ? value : "banbet";
}
function readPeriod(raw: unknown): YoloPeriod {
  const value = firstString(raw);
  return isYoloPeriod(value) ? value : "monthly";
}
function readStatus(raw: unknown): BetStatusFilter {
  const value = firstString(raw);
  return isBetStatusFilter(value) ? value : "all";
}

/**
 * GET /api/arena/leaderboard?type=banbet|yolopulse&period=daily|weekly|monthly|alltime
 *   &status=all|active|won|lost&page=1&pageSize=25&search=
 *
 * Public. The two types are separate boards and are never summed.
 */
yoloArenaRouter.get(
  "/arena/leaderboard",
  asyncHandler(async (req, res) => {
    const type = readType(req.query.type);
    const period = readPeriod(req.query.period);
    const page = Math.max(1, Number(firstString(req.query.page) ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(firstString(req.query.pageSize) ?? 25) || 25));

    const result = await readYoloLeaderboard({
      type,
      period,
      page,
      pageSize,
      search: firstString(req.query.search),
    });

    return res.json({
      data: result.rows,
      meta: {
        ...result.meta,
        // Echoed so the UI can keep its chip lit; it filters the BET list, not
        // the standings, because an unresolved bet has moved nobody's score.
        status: readStatus(req.query.status),
        periods: YOLO_PERIODS,
        scoringVersion: result.meta.scoringVersion ?? YOLO_SCORING_VERSION,
      },
    });
  }),
);

/** GET /api/arena/summary-cards?type=&period= — the four cards. Public. */
yoloArenaRouter.get(
  "/arena/summary-cards",
  asyncHandler(async (req, res) => {
    const type = readType(req.query.type);
    const period = readPeriod(req.query.period);
    const data = await readArenaSummary(type, period);
    return res.json({ data, meta: { type, period } });
  }),
);

/**
 * GET /api/arena/bets?type=&period=&status=&search=
 *
 * The individual bets behind a board. This is where `status=active` means
 * something: open bets are explorable here without polluting the standings.
 */
yoloArenaRouter.get(
  "/arena/bets",
  asyncHandler(async (req, res) => {
    const type = readType(req.query.type);
    const status = readStatus(req.query.status);
    const search = firstString(req.query.search)?.trim().toUpperCase();
    const limit = Math.min(100, Math.max(1, Number(firstString(req.query.limit) ?? 50) || 50));

    if (type === "yolopulse") {
      const rows = await prisma.yoloBets.findMany({
        where: {
          ...(status === "all" ? {} : { status }),
          ...(search ? { ticker: { contains: search } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return res.json({
        data: rows.map((b) => ({
          id: b.id,
          ticker: b.ticker,
          direction: b.direction,
          entryPrice: Number(b.entryPrice),
          targetPrice: Number(b.targetPrice),
          status: b.status,
          createdAt: b.entryTimestamp.toISOString(),
          expiresAt: b.expiresAt.toISOString(),
          resolvedAt: b.resolvedAt?.toISOString() ?? null,
          difficulty: b.difficulty === null ? null : Number(b.difficulty),
          rawScore: b.rawScore === null ? null : Number(b.rawScore),
          scoreDelta: b.scoreDelta === null ? null : Number(b.scoreDelta),
          volatilityAtEntry: b.volatilityAtEntry === null ? null : Number(b.volatilityAtEntry),
          expectedMove: b.expectedMove === null ? null : Number(b.expectedMove),
          scoringVersion: b.scoringVersion,
        })),
        meta: { type, status },
      });
    }

    const statusMap: Record<BetStatusFilter, string[] | null> = {
      all: null,
      active: ["open"],
      won: ["won"],
      lost: ["lost", "expired"],
    };
    const wanted = statusMap[status];
    const rows = await prisma.wsbBanbets.findMany({
      where: {
        confirmation: "confirmed",
        ...(wanted ? { status: { in: wanted } } : {}),
        ...(search ? { ticker: { contains: search } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return res.json({
      data: rows.map((b) => ({
        id: b.id,
        ticker: b.ticker,
        direction: b.side === "bull" ? "up" : "down",
        entryPrice: b.entryPrice === null ? null : Number(b.entryPrice),
        targetPrice: Number(b.targetPrice),
        status: b.status,
        createdAt: b.createdAt.toISOString(),
        expiresAt: b.expiresAt.toISOString(),
        resolvedAt: b.resolvedAt?.toISOString() ?? null,
        difficulty: b.difficulty === null ? null : Number(b.difficulty),
        rawScore: b.rawScore === null ? null : Number(b.rawScore),
        scoreDelta: b.scoreDelta === null ? null : Number(b.scoreDelta),
        sourceUrl: b.sourceUrl,
        scoringVersion: b.scoringVersion,
      })),
      meta: { type, status },
    });
  }),
);

/** GET /api/arena/bets/:id — one YOLOPulse bet, with its full score breakdown. */
yoloArenaRouter.get(
  "/arena/bets/:id",
  asyncHandler(async (req, res) => {
    const bet = await prisma.yoloBets.findUnique({ where: { id: req.params.id! } });
    if (!bet) return res.status(404).json({ error: { message: "Bet not found." } });
    return res.json({
      data: {
        id: bet.id,
        ticker: bet.ticker,
        direction: bet.direction,
        entryPrice: Number(bet.entryPrice),
        targetPrice: Number(bet.targetPrice),
        targetMovePercent:
          Math.round(
            ((Number(bet.targetPrice) - Number(bet.entryPrice)) / Number(bet.entryPrice)) * 1000,
          ) / 10,
        createdAt: bet.entryTimestamp.toISOString(),
        expiresAt: bet.expiresAt.toISOString(),
        status: bet.status,
        resolvedAt: bet.resolvedAt?.toISOString() ?? null,
        resultPrice: bet.resultPrice === null ? null : Number(bet.resultPrice),
        volatilityAtEntry: bet.volatilityAtEntry === null ? null : Number(bet.volatilityAtEntry),
        expectedMove: bet.expectedMove === null ? null : Number(bet.expectedMove),
        difficulty: bet.difficulty === null ? null : Number(bet.difficulty),
        rawScore: bet.rawScore === null ? null : Number(bet.rawScore),
        scoreDelta: bet.scoreDelta === null ? null : Number(bet.scoreDelta),
        scoringVersion: bet.scoringVersion,
      },
    });
  }),
);

/**
 * POST /api/arena/bets/preview — the numbers, without writing anything.
 *
 * So the Place Bet panel shows the BACKEND's difficulty and potential score
 * rather than a second implementation of the formula that could drift.
 */
yoloArenaRouter.post(
  "/arena/bets/preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { ticker, targetPrice, expiresAt } = req.body ?? {};
    if (typeof ticker !== "string" || typeof targetPrice !== "number" || typeof expiresAt !== "string") {
      return res.status(400).json({ error: { message: "ticker, targetPrice and expiresAt are required." } });
    }
    const deadline = new Date(expiresAt);
    if (Number.isNaN(deadline.getTime())) {
      return res.status(400).json({ error: { message: "expiresAt must be an ISO timestamp." } });
    }
    const result = await previewYoloBet({ ticker, targetPrice, expiresAt: deadline });
    if (!result.ok) return res.status(422).json({ error: { code: result.code, message: result.message } });
    return res.json({ data: result });
  }),
);

/**
 * POST /api/arena/bets — place one. Authenticated.
 *
 * The body carries a ticker, a target and a deadline, and NOTHING ELSE that
 * matters: entry price, direction, volatility and score are all determined
 * server-side. A client-supplied score is not validated, it is ignored.
 */
yoloArenaRouter.post(
  "/arena/bets",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { ticker, targetPrice, expiresAt } = req.body ?? {};
    if (typeof ticker !== "string" || typeof targetPrice !== "number" || typeof expiresAt !== "string") {
      return res.status(400).json({ error: { message: "ticker, targetPrice and expiresAt are required." } });
    }
    const deadline = new Date(expiresAt);
    if (Number.isNaN(deadline.getTime())) {
      return res.status(400).json({ error: { message: "expiresAt must be an ISO timestamp." } });
    }

    const result = await createYoloBet({
      userId: req.user!.id,
      ticker,
      targetPrice,
      expiresAt: deadline,
    });

    if (!result.ok) {
      const status = result.code === "duplicate_active" || result.code === "too_many_active" ? 409 : 422;
      return res.status(status).json({ error: { code: result.code, message: result.message } });
    }
    return res.status(201).json({ data: result });
  }),
);

/** GET /api/arena/rules — the numbers behind the score, for the tooltip. */
yoloArenaRouter.get(
  "/arena/rules",
  asyncHandler(async (_req, res) =>
    res.json({
      data: {
        scoringVersion: YOLO_SCORING_VERSION,
        difficultyExponent: YOLO_SCORE_CONFIG.difficultyExponent,
        lossMultiplier: YOLO_SCORE_CONFIG.lossMultiplier,
        maxPerBet: YOLO_SCORE_CONFIG.maxPerBet,
        minTargetMovePercent: YOLO_SCORE_CONFIG.minTargetMovePercent,
        minResolvedBetsForRanking: YOLO_SCORE_CONFIG.minResolvedBetsForRanking,
        maxActiveBetsPerUser: YOLO_SCORE_CONFIG.maxActiveBetsPerUser,
        minDeadlineMinutes: YOLO_SCORE_CONFIG.minDeadlineMinutes,
        maxDeadlineMinutes: YOLO_SCORE_CONFIG.maxDeadlineMinutes,
      },
    }),
  ),
);
