import { Router } from "express";

import { ok, asyncHandler } from "../lib/response.js";
import { metricsRepository } from "../repositories/metrics.repository.js";
import { marketRepository } from "../repositories/market.repository.js";
import { betsRepository, VERIFICATION_RANK } from "../repositories/bets.repository.js";

export const screenerRouter = Router();

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
    // The screen is the newest row per ticker from four independent feeds, left
    // joined onto the mention metrics. Each feed already has a "latest per
    // ticker" repository read, so they are fetched in parallel and joined here
    // on the ticker key.
    const [metrics, positioning, pumps, snapshots, verificationRank] =
      await Promise.all([
        metricsRepository.heatmap(),
        metricsRepository.positioningLatest(),
        metricsRepository.pumpLatest(),
        marketRepository.latestSnapshots(),
        betsRepository.verificationRankByTicker(),
      ]);

    const positioningByTicker = new Map(positioning.map((p) => [p.ticker, p]));
    const pumpByTicker = new Map(pumps.map((p) => [p.ticker, p]));
    const priceByTicker = new Map(snapshots.map((s) => [s.ticker, s.price]));

    const rows: ScreenerRow[] = metrics.map((m) => {
      const ticker = String(m.ticker);
      const position = positioningByTicker.get(ticker);
      return {
        ticker,
        mentions: Number(m.mentions ?? 0),
        mention_velocity: Number(m.mention_velocity ?? 0),
        sentiment_score: Number(m.sentiment_score ?? 0),
        declared_yolo_capital: position?.declared_yolo_capital ?? null,
        net_directional_conviction: position?.net_directional_conviction ?? null,
        pump_score: pumpByTicker.get(ticker)?.score ?? null,
        price: priceByTicker.get(ticker) ?? null,
        verification_rank: verificationRank.get(ticker) ?? 0,
      };
    });

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
