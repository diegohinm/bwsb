import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { betsRepository, type BetFilters } from "../repositories/bets.repository.js";
import { metricsRepository } from "../repositories/metrics.repository.js";
import { tickersRepository } from "../repositories/tickers.repository.js";
import { extractBets } from "../services/extraction/betExtractor.service.js";
import { classifyStance } from "../services/extraction/stanceClassifier.service.js";

export const betsRouter = Router();

/** GET /api/bets — filtered feed of structured bets. */
betsRouter.get(
  "/bets",
  asyncHandler(async (req, res) => {
    const q = req.query;
    const filters: BetFilters = {
      ticker: str(q.ticker),
      optionType: str(q.option_type),
      verificationLevel: str(q.verification_level),
      status: str(q.status),
      positionIntent: str(q.position_intent),
      minDeclaredCapital: num(q.min_declared_capital),
      limit: num(q.limit) ?? 100,
    };
    return ok(res, await betsRepository.list(filters));
  }),
);

// ── Static sub-paths must be registered before "/bets/:id" ──────────────────

/** GET /api/bets/leaderboard — real-bet leaderboard by return, with reputation. */
betsRouter.get(
  "/bets/leaderboard",
  asyncHandler(async (_req, res) => ok(res, await betsRepository.leaderboard())),
);

/** GET /api/bets/expiration-calendar — contracts/premium by expiration. */
betsRouter.get(
  "/bets/expiration-calendar",
  asyncHandler(async (_req, res) => ok(res, await betsRepository.expirationCalendar())),
);

/** GET /api/bets/collective-pl — collective P/L across all bets per ticker. */
betsRouter.get(
  "/bets/collective-pl",
  asyncHandler(async (_req, res) => ok(res, await betsRepository.collectivePl())),
);

/** GET /api/bets/positioning-index — latest positioning index per ticker. */
betsRouter.get(
  "/bets/positioning-index",
  asyncHandler(async (_req, res) => ok(res, await metricsRepository.positioningLatest())),
);

/**
 * POST /api/bets/extract-text — extract structured bets from free text.
 * Body: { text: string }
 */
betsRouter.post(
  "/bets/extract-text",
  asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) return fail(res, "Body must include a non-empty 'text' string");

    const tickers = await tickersRepository.listAll();
    const known = tickers.map((t) => t.ticker);
    const candidates = extractBets(text, known);
    const stance = classifyStance(text);

    return ok(res, {
      text,
      stance,
      bet_candidates: candidates,
      count: candidates.length,
      disclaimer: "Signals are informational only, not investment advice.",
    });
  }),
);

/**
 * POST /api/bets/extract-screenshot-placeholder — OCR extraction scaffold.
 * Returns a not-implemented-yet marker with the intended interface.
 */
betsRouter.post(
  "/bets/extract-screenshot-placeholder",
  asyncHandler(async (_req, res) =>
    ok(res, {
      status: "not_implemented",
      message:
        "Screenshot OCR extraction is scaffolded. A future OCR adapter will return the same bet-candidate shape as /bets/extract-text.",
      ocr_provider: "stub",
    }),
  ),
);

// ── Parameterized routes ────────────────────────────────────────────────────

/** GET /api/bets/:id — single bet with legs, verifications and lifecycle. */
betsRouter.get(
  "/bets/:id",
  asyncHandler(async (req, res) => {
    const bet = await betsRepository.findById(req.params.id);
    if (!bet) return fail(res, "Bet not found", 404);
    const [legs, verifications, lifecycle, performance] = await Promise.all([
      betsRepository.legsForBet(bet.id),
      betsRepository.verificationsForBet(bet.id),
      betsRepository.lifecycleForBet(bet.id),
      betsRepository.performanceForBet(bet.id),
    ]);
    return ok(res, { ...bet, legs, verifications, lifecycle, performance });
  }),
);

/** GET /api/bets/:id/snapshots — value/return snapshots over time. */
betsRouter.get(
  "/bets/:id/snapshots",
  asyncHandler(async (req, res) => ok(res, await betsRepository.snapshotsForBet(req.params.id))),
);

/** GET /api/bets/:id/performance — realized/peak/trough performance. */
betsRouter.get(
  "/bets/:id/performance",
  asyncHandler(async (req, res) => {
    const perf = await betsRepository.performanceForBet(req.params.id);
    if (!perf) return fail(res, "No performance record for this bet", 404);
    return ok(res, perf);
  }),
);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  return typeof v === "string" && v.length && Number.isFinite(n) ? n : undefined;
}
