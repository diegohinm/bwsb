/**
 * researchReport.service.ts
 *
 * Reads persisted research_reports and can synthesize a simple text summary
 * from current analytics as a baseline for auto-generated research.
 */
import { prisma } from "../../lib/prisma.js";
import { toDbRow, toDbRows } from "../../lib/rows.js";
import { metricsRepository } from "../../repositories/metrics.repository.js";
import { betsRepository } from "../../repositories/bets.repository.js";
import type { ResearchReport } from "../../types/domain.js";

const DISCLAIMER = "Signals are informational only, not investment advice.";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const researchService = {
  async list(): Promise<ResearchReport[]> {
    const rows = await prisma.researchReports.findMany({
      orderBy: { createdAt: "desc" },
    });
    return toDbRows<ResearchReport>("ResearchReports", rows);
  },

  /**
   * Look a report up by slug, falling back to its id.
   *
   * `id::text = $1` tolerated a non-uuid input; the id lookup is only attempted
   * for something that actually is a uuid, because Prisma would otherwise raise
   * a type error on the uuid column.
   */
  async bySlugOrId(idOrSlug: string): Promise<ResearchReport | null> {
    const bySlug = await prisma.researchReports.findFirst({
      where: { slug: idOrSlug },
    });
    if (bySlug) return toDbRow<ResearchReport>("ResearchReports", bySlug);

    if (!UUID_RE.test(idOrSlug)) return null;

    const byId = await prisma.researchReports.findUnique({ where: { id: idOrSlug } });
    return byId ? toDbRow<ResearchReport>("ResearchReports", byId) : null;
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
