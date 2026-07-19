/**
 * researchReport.service.ts
 *
 * Reads persisted research_reports and can synthesize a simple text summary
 * from current analytics as a baseline for auto-generated research.
 */
import { query } from "../../lib/db.js";
import { metricsRepository } from "../../repositories/metrics.repository.js";
import { betsRepository } from "../../repositories/bets.repository.js";
import type { ResearchReport } from "../../types/domain.js";

const DISCLAIMER = "Signals are informational only, not investment advice.";

export const researchService = {
  list(): Promise<ResearchReport[]> {
    return query<ResearchReport>(
      `SELECT * FROM public.research_reports ORDER BY created_at DESC`,
    );
  },

  bySlugOrId(idOrSlug: string): Promise<ResearchReport | null> {
    return query<ResearchReport>(
      `SELECT * FROM public.research_reports WHERE slug = $1 OR id::text = $1 LIMIT 1`,
      [idOrSlug],
    ).then((rows) => rows[0] ?? null);
  },

  /** Generate a plain-text market recap from current attention + positioning. */
  async generateMarketRecap(): Promise<{ title: string; body: string }> {
    const [attention, positioning, collective] = await Promise.all([
      metricsRepository.attentionIndex(),
      metricsRepository.positioningLatest(),
      betsRepository.collectivePl(),
    ]);

    const topCall = [...positioning].sort(
      (a, b) => Number(b.call_conviction) - Number(a.call_conviction),
    )[0];
    const topPut = [...positioning].sort(
      (a, b) => Number(b.put_conviction) - Number(a.put_conviction),
    )[0];
    const worst = [...collective].sort(
      (a, b) => Number(a.avg_return_pct) - Number(b.avg_return_pct),
    )[0];

    const idx = attention as { index_value?: number; label?: string } | null;

    const body = [
      `# Retail Bet Recap`,
      ``,
      `Retail Attention Index: ${idx?.index_value ?? "n/a"} (${idx?.label ?? "n/a"}).`,
      topCall
        ? `Strongest call conviction: ${topCall.ticker} (${topCall.call_conviction}).`
        : "",
      topPut
        ? `Strongest put conviction: ${topPut.ticker} (${topPut.put_conviction}).`
        : "",
      worst
        ? `Weakest collective P/L: ${worst.ticker} (${worst.avg_return_pct}% avg).`
        : "",
      ``,
      `*${DISCLAIMER}*`,
    ]
      .filter(Boolean)
      .join("\n");

    return { title: "Retail Bet Recap", body };
  },
};
