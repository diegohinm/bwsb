import { Router } from "express";

import { ok, asyncHandler } from "../lib/response.js";
import { metricsRepository } from "../repositories/metrics.repository.js";
import { computeBreadth } from "../services/scoring/breadthConcentration.service.js";

export const trendsRouter = Router();

// Map public trend routes to internal classification names.
const CLASSIFICATION: Record<string, string> = {
  "most-mentioned": "most_mentioned",
  surging: "acceleration",
  breaking: "fresh_breakout",
  bulls: "bullish_pressure",
  bears: "bearish_pressure",
  contested: "disagreement",
  echo: "one_sided_attention",
  pennies: "penny_attention",
};

for (const [path, classification] of Object.entries(CLASSIFICATION)) {
  trendsRouter.get(
    `/trends/${path}`,
    asyncHandler(async (_req, res) =>
      ok(res, await metricsRepository.trendByClassification(classification)),
    ),
  );
}

/** GET /api/trends/heatmap — latest metrics for every ticker. */
trendsRouter.get(
  "/trends/heatmap",
  asyncHandler(async (_req, res) => ok(res, await metricsRepository.heatmap())),
);

/** GET /api/trends/mention-share — share of mentions across tickers. */
trendsRouter.get(
  "/trends/mention-share",
  asyncHandler(async (_req, res) => ok(res, await metricsRepository.mentionShare())),
);

/** GET /api/trends/breadth — breadth vs concentration (Gini). */
trendsRouter.get(
  "/trends/breadth",
  asyncHandler(async (_req, res) => {
    const share = (await metricsRepository.mentionShare(50)) as Array<{
      ticker: string;
      mentions: number;
    }>;
    return ok(res, { rows: share, ...computeBreadth(share) });
  }),
);

/** GET /api/trends/retail-attention-index — our own attention index. */
trendsRouter.get(
  "/trends/retail-attention-index",
  asyncHandler(async (_req, res) => ok(res, await metricsRepository.attentionIndex())),
);
