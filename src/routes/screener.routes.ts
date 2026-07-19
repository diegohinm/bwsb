import { Router } from "express";

import { ok, asyncHandler } from "../lib/response.js";
import { query } from "../lib/db.js";
import { metricsRepository } from "../repositories/metrics.repository.js";

export const screenerRouter = Router();

const VERIFICATION_RANK: Record<string, number> = {
  unverified: 0,
  text_only: 1,
  screenshot_detected: 2,
  internally_consistent: 3,
  market_validated: 4,
  follow_up_verified: 5,
};

interface ScreenerRow {
  ticker: string;
  mentions: number;
  mention_velocity: number;
  sentiment_score: number;
  pump_score: number | null;
  declared_yolo_capital: number | null;
  net_directional_conviction: number | null;
  price: number | null;
  verification_rank: number;
}

/**
 * GET /api/screener — combined per-ticker screen.
 * Query filters: min_mentions, min_acceleration, stance, min_declared_capital,
 * max_pump_risk, min_verification_level, penny_only, breakout_only,
 * unusual_options_only.
 */
screenerRouter.get(
  "/screener",
  asyncHandler(async (req, res) => {
    const rows = (await query(
      `SELECT m.ticker, m.mentions, m.mention_velocity, m.sentiment_score,
              p.declared_yolo_capital, p.net_directional_conviction,
              pc.score AS pump_score, ms.price,
              coalesce(bv.vrank, 0) AS verification_rank
       FROM (SELECT DISTINCT ON (ticker) ticker, mentions, mention_velocity, sentiment_score
             FROM public.ticker_metrics_5m ORDER BY ticker, bucket_start DESC) m
       LEFT JOIN (SELECT DISTINCT ON (ticker) ticker, declared_yolo_capital, net_directional_conviction
             FROM public.ticker_positioning_indexes ORDER BY ticker, bucket_start DESC) p ON p.ticker = m.ticker
       LEFT JOIN (SELECT DISTINCT ON (ticker) ticker, score
             FROM public.pump_coordination_scores ORDER BY ticker, bucket_start DESC) pc ON pc.ticker = m.ticker
       LEFT JOIN (SELECT DISTINCT ON (ticker) ticker, price
             FROM public.market_snapshots ORDER BY ticker, snapshot_at DESC) ms ON ms.ticker = m.ticker
       LEFT JOIN (SELECT ticker, max(CASE verification_level
             WHEN 'follow_up_verified' THEN 5 WHEN 'market_validated' THEN 4
             WHEN 'internally_consistent' THEN 3 WHEN 'screenshot_detected' THEN 2
             WHEN 'text_only' THEN 1 ELSE 0 END) AS vrank
             FROM public.bets GROUP BY ticker) bv ON bv.ticker = m.ticker`,
    )) as ScreenerRow[];

    const breakoutSet = new Set(
      (await metricsRepository.trendByClassification("fresh_breakout", 50)).map((r) => r.ticker),
    );

    const q = req.query;
    const minMentions = numParam(q.min_mentions);
    const minAccel = numParam(q.min_acceleration);
    const stance = strParam(q.stance);
    const minCapital = numParam(q.min_declared_capital);
    const maxPump = numParam(q.max_pump_risk);
    const minVerification = strParam(q.min_verification_level);
    const pennyOnly = boolParam(q.penny_only);
    const breakoutOnly = boolParam(q.breakout_only);
    const unusualOnly = boolParam(q.unusual_options_only);
    const minVerRank = minVerification ? VERIFICATION_RANK[minVerification] ?? 0 : 0;

    const filtered = rows.filter((r) => {
      if (minMentions != null && Number(r.mentions) < minMentions) return false;
      if (minAccel != null && Number(r.mention_velocity) < minAccel) return false;
      if (stance) {
        const s = Number(r.sentiment_score);
        const label = s > 0.55 ? "bullish" : s < 0.45 ? "bearish" : "neutral";
        if (label !== stance) return false;
      }
      if (minCapital != null && Number(r.declared_yolo_capital ?? 0) < minCapital) return false;
      if (maxPump != null && Number(r.pump_score ?? 0) > maxPump) return false;
      if (minVerRank > 0 && Number(r.verification_rank) < minVerRank) return false;
      if (pennyOnly && !(r.price != null && Number(r.price) < 5)) return false;
      if (breakoutOnly && !breakoutSet.has(r.ticker)) return false;
      if (unusualOnly && !(Number(r.declared_yolo_capital ?? 0) > 10000)) return false;
      return true;
    });

    return ok(res, filtered);
  }),
);

function numParam(v: unknown): number | null {
  const n = Number(v);
  return typeof v === "string" && v.length && Number.isFinite(n) ? n : null;
}
function strParam(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}
function boolParam(v: unknown): boolean {
  return v === "true" || v === "1";
}
