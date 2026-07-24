import { query } from "../lib/db.js";
import { competitionRepository } from "../repositories/competition.repository.js";

/**
 * Recompute the Arena leaderboard for every active competition and persist a
 * ranked snapshot row per participant. Manual/dev:
 *   npm run leaderboard:recalculate
 *
 * Idempotent by design — it appends a fresh timestamped snapshot each run
 * (history is intentional); reading the latest snapshot_at gives the current
 * standings. A DB failure on one competition must NOT crash the job or skip the
 * others, so every competition is wrapped independently.
 *
 * Leaves verifiable evidence in public.competition_leaderboard_snapshots.
 */

interface LeaderboardRow {
  user_id: string;
  rank: number | string;
  equity_value: number | string | null;
  return_pct: number | string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : null;
};

async function main(): Promise<void> {
  let competitions: Array<{ id: string; name: string }> = [];
  try {
    competitions = await query<{ id: string; name: string }>(
      `SELECT id, name FROM public.competitions WHERE is_active = true ORDER BY created_at ASC`,
    );
  } catch (err) {
    console.error(
      "[leaderboard:recalculate] cannot read competitions:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (competitions.length === 0) {
    console.log("[leaderboard:recalculate] no active competitions — nothing to do.");
    return;
  }

  let totalRows = 0;
  for (const competition of competitions) {
    try {
      const rows = (await competitionRepository.leaderboard(
        competition.id,
      )) as LeaderboardRow[];

      let written = 0;
      for (const row of rows) {
        await query(
          `INSERT INTO public.competition_leaderboard_snapshots
             (competition_id, user_id, rank, equity_value, return_pct)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            competition.id,
            row.user_id,
            num(row.rank),
            num(row.equity_value),
            num(row.return_pct),
          ],
        );
        written += 1;
      }
      totalRows += written;
      console.log(
        `[leaderboard:recalculate] "${competition.name}" (${competition.id}): ${written} ranked snapshot rows written`,
      );
    } catch (err) {
      console.error(
        `[leaderboard:recalculate] competition ${competition.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[leaderboard:recalculate] done — ${totalRows} snapshot rows across ${competitions.length} competition(s).`,
  );
}

void main();
