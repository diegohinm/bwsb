import { Router } from "express";

import { ok, asyncHandler } from "../lib/response.js";
import { tickersRepository } from "../repositories/tickers.repository.js";
import { query } from "../lib/db.js";

export const searchRouter = Router();

/**
 * GET /api/search/tickers?q=QUERY&limit=8
 *
 * Public global ticker/company search for the header search bar. No auth.
 * Returns `{ data: [] }` for an empty query. Mounted under /api, so the
 * effective path is /api/search/tickers.
 */
searchRouter.get("/search/tickers", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  let limit = Number(req.query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 8;
  limit = Math.min(Math.floor(limit), 20);

  if (!q) return ok(res, []);

  try {
    const rows = await tickersRepository.searchTickers(q, limit);
    return ok(res, rows);
  } catch (err) {
    console.error("Failed to search tickers:", err);
    return res.status(500).json({ error: "Failed to search tickers" });
  }
});

/** GET /api/search?q= — search tickers and posts. */
searchRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return ok(res, { query: "", tickers: [], posts: [] });

    const [tickers, posts] = await Promise.all([
      tickersRepository.search(q, 10),
      query(
        `SELECT reddit_post_id, subreddit, title, score, num_comments, reddit_created_at
         FROM public.reddit_posts
         WHERE title ILIKE $1 OR body_excerpt ILIKE $1
         ORDER BY reddit_created_at DESC NULLS LAST LIMIT 10`,
        [`%${q}%`],
      ),
    ]);

    return ok(res, { query: q, tickers, posts });
  }),
);

/**
 * POST /api/search/natural-language-placeholder — NL search scaffold.
 * Body: { q: string }. Returns the intended interface without an LLM wired in.
 */
searchRouter.post(
  "/search/natural-language-placeholder",
  asyncHandler(async (req, res) => {
    const q = typeof req.body?.q === "string" ? req.body.q : "";
    return ok(res, {
      status: "not_implemented",
      query: q,
      message:
        "Natural-language search is scaffolded. A future LLM adapter will parse this query into structured screener filters.",
      parsed_filters_stub: {},
    });
  }),
);
