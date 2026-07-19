import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { researchService } from "../services/research/researchReport.service.js";

export const researchRouter = Router();

/** GET /api/research/reports — list research reports. */
researchRouter.get(
  "/research/reports",
  asyncHandler(async (_req, res) => ok(res, await researchService.list())),
);

/** GET /api/research/reports/:id — one report by slug or id. */
researchRouter.get(
  "/research/reports/:id",
  asyncHandler(async (req, res) => {
    const report = await researchService.bySlugOrId(req.params.id);
    if (!report) return fail(res, "Report not found", 404);
    return ok(res, report);
  }),
);
