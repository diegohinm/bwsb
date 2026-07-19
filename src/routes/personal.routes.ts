import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { personalRepository } from "../repositories/personal.repository.js";
import { virtualRepository } from "../repositories/virtual.repository.js";
import {
  ensureAccount,
  getPortfolio,
  placeTrade,
  type TradeInput,
} from "../services/portfolio/virtualAccount.service.js";
import {
  getCompetitionView,
  joinActiveCompetition,
} from "../services/competition/competition.service.js";

/**
 * Protected personal-feature routes. Every route here requires a signed-in
 * user; `requireAuth` attaches `req.user`. Mounted under /api.
 */
export const personalRouter = Router();

personalRouter.use(requireAuth);

// Helper: the authenticated user id (requireAuth guarantees req.user).
function userId(req: { user?: { id: string } }): string {
  return req.user!.id;
}

/** GET /api/me — the signed-in user's profile. */
personalRouter.get(
  "/me",
  asyncHandler(async (req, res) => ok(res, { user: req.user })),
);

/** GET /api/account — profile + virtual account summary. */
personalRouter.get(
  "/account",
  asyncHandler(async (req, res) => {
    const account = await ensureAccount(userId(req));
    return ok(res, { user: req.user, virtual_account: account });
  }),
);

// ── Watchlist ────────────────────────────────────────────────────────────────
personalRouter.get(
  "/watchlist",
  asyncHandler(async (req, res) => ok(res, await personalRepository.watchlistItems(userId(req)))),
);

personalRouter.post(
  "/watchlist",
  asyncHandler(async (req, res) => {
    const ticker = typeof req.body?.ticker === "string" ? req.body.ticker : "";
    if (!ticker) return fail(res, "ticker is required");
    const row = await personalRepository.addWatchlistItem(userId(req), ticker);
    return ok(res, row ?? { ticker: ticker.toUpperCase(), already_present: true }, 201);
  }),
);

personalRouter.delete(
  "/watchlist/:ticker",
  asyncHandler(async (req, res) => {
    const rows = await personalRepository.removeWatchlistItem(userId(req), req.params.ticker);
    if (!rows.length) return fail(res, "Ticker not on watchlist", 404);
    return ok(res, { deleted: true });
  }),
);

// ── Personal alert rules ─────────────────────────────────────────────────────
personalRouter.get(
  "/my-alerts",
  asyncHandler(async (req, res) => ok(res, await personalRepository.myAlerts(userId(req)))),
);

personalRouter.post(
  "/my-alerts",
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    if (!body.alert_type) return fail(res, "alert_type is required");
    const row = await personalRepository.createAlert({
      user_id: userId(req),
      ticker: body.ticker ?? null,
      alert_type: body.alert_type,
      condition: body.condition ?? {},
      delivery_channels: body.delivery_channels ?? ["in_app"],
    });
    return ok(res, row, 201);
  }),
);

personalRouter.delete(
  "/my-alerts/:id",
  asyncHandler(async (req, res) => {
    const rows = await personalRepository.deleteAlert(userId(req), req.params.id);
    if (!rows.length) return fail(res, "Alert rule not found", 404);
    return ok(res, { deleted: true });
  }),
);

// ── Notifications ────────────────────────────────────────────────────────────
personalRouter.get(
  "/notifications",
  asyncHandler(async (req, res) => ok(res, await personalRepository.notifications(userId(req)))),
);

personalRouter.patch(
  "/notifications/:id/read",
  asyncHandler(async (req, res) => {
    const rows = await personalRepository.markNotificationRead(userId(req), req.params.id);
    if (!rows.length) return fail(res, "Notification not found", 404);
    return ok(res, rows[0]);
  }),
);

// ── Virtual portfolio / paper trading ────────────────────────────────────────
personalRouter.get(
  "/portfolio",
  asyncHandler(async (req, res) => ok(res, await getPortfolio(userId(req)))),
);

personalRouter.get(
  "/portfolio/virtual-trades",
  asyncHandler(async (req, res) => {
    const account = await ensureAccount(userId(req));
    return ok(res, await virtualRepository.listTrades(account.id, 100));
  }),
);

personalRouter.post(
  "/portfolio/virtual-trades",
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    try {
      const result = await placeTrade(userId(req), body as TradeInput);
      return ok(res, result, 201);
    } catch (err) {
      return fail(res, err instanceof Error ? err.message : "Trade failed");
    }
  }),
);

// ── Competition ──────────────────────────────────────────────────────────────
personalRouter.get(
  "/competition",
  asyncHandler(async (req, res) => ok(res, await getCompetitionView(userId(req)))),
);

personalRouter.post(
  "/competition/join",
  asyncHandler(async (req, res) => {
    const result = await joinActiveCompetition(userId(req));
    return ok(res, result, 201);
  }),
);
