import { Router } from "express";

import { ok, asyncHandler } from "../lib/response.js";
import { tickersRepository } from "../repositories/tickers.repository.js";
import { query } from "../lib/db.js";
import { searchCatalog } from "../config/tickerCatalog.js";
import { TRACKED_SUBREDDITS } from "../services/social/subreddits.js";
import type { Ticker } from "../types/domain.js";

export const searchRouter = Router();

/**
 * Merge DB ticker results with the centralized catalog so well-known symbols
 * (RDDT, NVDA, …) always resolve even when the `tickers` table is empty or
 * unreachable. DB rows win on conflicts; catalog backfills the rest.
 */
async function resolveTickers(term: string, limit: number): Promise<Ticker[]> {
  let dbRows: Ticker[] = [];
  try {
    dbRows = await tickersRepository.searchTickers(term, limit);
  } catch (err) {
    // DB unavailable/unseeded — degrade to the catalog rather than failing.
    console.error("Ticker search DB lookup failed, using catalog:", err);
  }

  const seen = new Set(dbRows.map((r) => r.ticker.toUpperCase()));
  const merged = [...dbRows];
  for (const c of searchCatalog(term, limit)) {
    if (merged.length >= limit) break;
    if (seen.has(c.ticker.toUpperCase())) continue;
    seen.add(c.ticker.toUpperCase());
    merged.push(c);
  }
  return merged.slice(0, limit);
}

/** Subreddits whose name/label matches the query, shaped for the search UI. */
function resolveSubreddits(term: string, limit = 5) {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  return TRACKED_SUBREDDITS.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.shortLabel.toLowerCase().includes(q),
  )
    .slice(0, limit)
    .map((s) => ({ name: s.name, label: `r/${s.name}`, blurb: s.blurb }));
}

/**
 * GET /api/search/tickers?q=QUERY&limit=8
 *
 * Public global ticker/company search for the header search bar. No auth.
 * Returns `{ data: [] }` for an empty query. Resilient: always resolves known
 * tickers via the centralized catalog even without a seeded database.
 */
searchRouter.get(
  "/search/tickers",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 8;
    limit = Math.min(Math.floor(limit), 20);

    if (!q) return ok(res, []);

    return ok(res, await resolveTickers(q, limit));
  }),
);

/**
 * GET /api/search?q=&limit=
 *
 * Public grouped global search for the header bar. Returns tickers + matching
 * tracked subreddits (+ best-effort recent posts). Every group degrades
 * gracefully so a single failing source never breaks the dropdown.
 */
searchRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 8;
    limit = Math.min(Math.floor(limit), 20);

    if (!q) {
      return ok(res, { query: "", tickers: [], subreddits: [], posts: [] });
    }

    const tickers = await resolveTickers(q, limit);
    const subreddits = resolveSubreddits(q);

    let posts: unknown[] = [];
    try {
      posts = await query(
        `SELECT reddit_post_id, subreddit, title, score, num_comments, reddit_created_at
         FROM public.reddit_posts
         WHERE title ILIKE $1 OR body_excerpt ILIKE $1
         ORDER BY reddit_created_at DESC NULLS LAST LIMIT 5`,
        [`%${q}%`],
      );
    } catch (err) {
      // Posts are a bonus surface — never let them break search.
      console.error("Search posts lookup failed:", err);
    }

    return ok(res, { query: q, tickers, subreddits, posts });
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
