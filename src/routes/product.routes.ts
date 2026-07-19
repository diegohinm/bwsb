import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { portfolioRepository } from "../repositories/portfolio.repository.js";
import { getDemoPortfolio } from "../services/portfolio/portfolio.service.js";
import { researchService } from "../services/research/researchReport.service.js";
import { DEMO_USER_ID } from "../types/domain.js";

export const productRouter = Router();

/** GET /api/portfolio/demo — demo portfolio with P/L and linked signals. */
productRouter.get(
  "/portfolio/demo",
  asyncHandler(async (_req, res) => ok(res, await getDemoPortfolio(DEMO_USER_ID))),
);

/** GET /api/watchlist/demo — demo watchlist items. */
productRouter.get(
  "/watchlist/demo",
  asyncHandler(async (_req, res) => ok(res, await portfolioRepository.watchlistItems(DEMO_USER_ID))),
);

/** GET /api/summaries/daily — daily personalized summary (demo user). */
productRouter.get(
  "/summaries/daily",
  asyncHandler(async (_req, res) => {
    const rows = await portfolioRepository.dailySummary(DEMO_USER_ID);
    if (rows.length) return ok(res, rows[0]);
    // Fall back to a freshly synthesized recap when none is stored.
    const recap = await researchService.generateMarketRecap();
    return ok(res, { day: null, summary: recap.body, highlights: [] });
  }),
);

/** GET /api/webhooks — demo user's webhook subscriptions. */
productRouter.get(
  "/webhooks",
  asyncHandler(async (_req, res) => ok(res, await portfolioRepository.webhooks(DEMO_USER_ID))),
);

/** POST /api/webhooks — create a webhook subscription. */
productRouter.post(
  "/webhooks",
  asyncHandler(async (req, res) => {
    const targetUrl = typeof req.body?.target_url === "string" ? req.body.target_url : "";
    if (!targetUrl) return fail(res, "target_url is required");
    const eventTypes = Array.isArray(req.body?.event_types) ? req.body.event_types : [];
    const rows = await portfolioRepository.insertWebhook(DEMO_USER_ID, targetUrl, eventTypes);
    return ok(res, rows[0], 201);
  }),
);

/** DELETE /api/webhooks/:id — remove a webhook subscription. */
productRouter.delete(
  "/webhooks/:id",
  asyncHandler(async (req, res) => {
    const rows = await portfolioRepository.deleteWebhook(DEMO_USER_ID, req.params.id);
    if (!rows.length) return fail(res, "Webhook not found", 404);
    return ok(res, { deleted: true });
  }),
);
