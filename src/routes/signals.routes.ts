import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { query } from "../lib/db.js";
import { postsRepository } from "../repositories/posts.repository.js";
import { metricsRepository } from "../repositories/metrics.repository.js";
import { mentionsRepository } from "../repositories/mentions.repository.js";
import { marketRepository } from "../repositories/market.repository.js";
import { tickersRepository } from "../repositories/tickers.repository.js";
import { detectBagholder } from "../services/extraction/bagholderDetector.service.js";
import { classifyPsychology } from "../services/extraction/psychologyClassifier.service.js";

export const signalsRouter = Router();

/** GET /api/signals/realtime — latest per-ticker sentiment snapshot. */
signalsRouter.get(
  "/signals/realtime",
  asyncHandler(async (_req, res) => ok(res, await metricsRepository.heatmap())),
);

/** GET /api/signals/direction — 1h and 24h rule-based direction signals. */
signalsRouter.get(
  "/signals/direction",
  asyncHandler(async (_req, res) => {
    const [oneHour, oneDay] = await Promise.all([
      metricsRepository.signalsByType("direction_1h"),
      metricsRepository.signalsByType("direction_24h"),
    ]);
    return ok(res, { "1h": oneHour, "24h": oneDay });
  }),
);

/** GET /api/signals/layers/:ticker — stacked signal layers for one ticker. */
signalsRouter.get(
  "/signals/layers/:ticker",
  asyncHandler(async (req, res) => {
    const symbol = req.params.ticker.toUpperCase();
    const [positioning, market, metrics, shortInterest, news, insider, social] =
      await Promise.all([
        metricsRepository.positioningForTicker(symbol),
        marketRepository.latestSnapshot(symbol),
        metricsRepository.latest5mForTicker(symbol),
        marketRepository.shortInterest(symbol),
        marketRepository.newsForTicker(symbol, 5),
        marketRepository.insiderForTicker(symbol, 5),
        marketRepository.externalSocial(symbol),
      ]);

    const sentiment = metrics ? Number(metrics.sentiment_score) : null;
    const priceChange = market ? Number(market.change_pct) : null;
    const sentimentPriceDivergence =
      sentiment != null && priceChange != null
        ? Math.round((sentiment - (priceChange / 10 + 0.5)) * 100) / 100
        : null;

    return ok(res, {
      ticker: symbol,
      layers: {
        options_activity: positioning,
        bagholder_pressure: metrics ? Number(metrics.pump_language_score) : null,
        retail_psychology: sentiment,
        volume_divergence:
          market && market.volume && market.avg_volume
            ? Math.round((Number(market.volume) / Number(market.avg_volume)) * 100) / 100
            : null,
        sentiment_price_divergence: sentimentPriceDivergence,
        news_correlation: news,
        insider_activity: insider,
        external_social: social,
        squeeze_risk: shortInterest,
      },
      disclaimer: "Signals are informational only, not investment advice.",
    });
  }),
);

/** GET /api/signals/bagholders — bagholder pressure across recent posts. */
signalsRouter.get(
  "/signals/bagholders",
  asyncHandler(async (_req, res) => {
    const posts = await postsRepository.recent(50);
    const rows = posts
      .map((p) => {
        const result = detectBagholder(`${p.title} ${p.body_excerpt ?? ""}`);
        return {
          reddit_post_id: p.reddit_post_id,
          title: p.title,
          subreddit: p.subreddit,
          score: result.score,
          down_percent: result.downPercent,
          matched: result.matched,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    return ok(res, rows);
  }),
);

/** GET /api/signals/psychology — retail psychology tags across recent posts. */
signalsRouter.get(
  "/signals/psychology",
  asyncHandler(async (_req, res) => {
    const posts = await postsRepository.recent(50);
    const rows = posts
      .map((p) => {
        const result = classifyPsychology(`${p.title} ${p.body_excerpt ?? ""}`);
        return {
          reddit_post_id: p.reddit_post_id,
          title: p.title,
          subreddit: p.subreddit,
          retail_psychology_score: result.retailPsychologyScore,
          tags: result.tags,
        };
      })
      .filter((r) => r.tags.length > 0)
      .sort((a, b) => b.retail_psychology_score - a.retail_psychology_score);
    return ok(res, rows);
  }),
);

/** GET /api/signals/divergence — stance divergence across subreddits per ticker. */
signalsRouter.get(
  "/signals/divergence",
  asyncHandler(async (_req, res) => {
    const tickers = await tickersRepository.listAll();
    const rows = [];
    for (const t of tickers.slice(0, 12)) {
      const bySub = (await mentionsRepository.stanceBySubreddit(t.ticker)) as Array<{
        subreddit: string;
        bullish: number;
        bearish: number;
      }>;
      if (bySub.length > 1) {
        rows.push({ ticker: t.ticker, by_subreddit: bySub });
      }
    }
    return ok(res, rows);
  }),
);

/** GET /api/signals/squeeze-risk — short interest / squeeze risk. */
signalsRouter.get(
  "/signals/squeeze-risk",
  asyncHandler(async (_req, res) => ok(res, await marketRepository.shortInterestLatest())),
);

/** GET /api/signals/accuracy — baseline signal accuracy from resolved history. */
signalsRouter.get(
  "/signals/accuracy",
  asyncHandler(async (_req, res) => {
    const rows = (await query(
      `SELECT count(*)::int AS resolved,
              count(*) FILTER (WHERE outcome = 'win')::int AS wins,
              round(avg(return_pct)::numeric, 2) AS avg_return
       FROM public.author_signal_history WHERE resolved_at IS NOT NULL`,
    )) as Array<{ resolved: number; wins: number; avg_return: number | null }>;
    const stats = rows[0];
    if (!stats || stats.resolved === 0) return fail(res, "No resolved signals yet", 404);
    return ok(res, {
      resolved_signals: stats.resolved,
      wins: stats.wins,
      hit_rate: Math.round((stats.wins / stats.resolved) * 100) / 100,
      average_return_pct: stats.avg_return,
    });
  }),
);
