import { Router, type Request, type Response } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import type { Ticker } from "../types/ticker.js";

export const tickersRouter = Router();

/**
 * GET /api/tickers
 * Returns all tickers ordered alphabetically by symbol.
 */
tickersRouter.get("/tickers", async (_req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("tickers")
    .select(
      "ticker, company_name, exchange, is_active, is_common_word, created_at",
    )
    .order("ticker", { ascending: true });

  if (error) {
    // Log server-side details; never leak them to the client.
    console.error("Error fetching tickers:", error.message);
    return res.status(500).json({ error: "Failed to fetch tickers" });
  }

  return res.json({ data: (data ?? []) as Ticker[] });
});
