import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { alertsRepository } from "../repositories/alerts.repository.js";
import { generateAndPersistAlerts } from "../services/alerts/alertEngine.service.js";
import { DEMO_USER_ID } from "../types/domain.js";

export const alertsRouter = Router();

/** GET /api/alerts — evidence-based alerts, most recent first. */
alertsRouter.get(
  "/alerts",
  asyncHandler(async (_req, res) => ok(res, await alertsRepository.list())),
);

/** POST /api/alerts/generate — run the alert engine and persist candidates. */
alertsRouter.post(
  "/alerts/generate",
  asyncHandler(async (_req, res) => {
    const inserted = await generateAndPersistAlerts();
    return ok(res, { generated: inserted.length, alerts: inserted }, 201);
  }),
);

/** GET /api/alert-rules — demo user's alert rules. */
alertsRouter.get(
  "/alert-rules",
  asyncHandler(async (_req, res) => ok(res, await alertsRepository.listRules(DEMO_USER_ID))),
);

/** POST /api/alert-rules — create an alert rule for the demo user. */
alertsRouter.post(
  "/alert-rules",
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    if (!body.rule_type) return fail(res, "rule_type is required");
    const rows = await alertsRepository.insertRule({
      user_id: DEMO_USER_ID,
      name: body.name ?? "Untitled rule",
      rule_type: body.rule_type,
      ticker: body.ticker ?? null,
      params: body.params ?? {},
    });
    return ok(res, rows[0], 201);
  }),
);
