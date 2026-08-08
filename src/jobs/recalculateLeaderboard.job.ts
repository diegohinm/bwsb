import { isMainModule } from "../lib/jobRunner.js";
import { prisma, disconnectPrisma } from "../lib/prisma.js";
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
    competitions = await prisma.competitions.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    });
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

      // One snapshot batch per competition: a partially written leaderboard
      // would rank some participants against an incomplete field.
      const { count: written } = await prisma.competitionLeaderboardSnapshots.createMany({
        data: rows.map((row) => ({
          competitionId: competition.id,
          userId: row.user_id,
          rank: num(row.rank),
          equityValue: num(row.equity_value),
          returnPct: num(row.return_pct),
        })),
      });
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

/**
 * Standalone script entrypoint.
 *
 * GUARDED BY `isMainModule`. Without it, merely IMPORTING this file — from a
 * test, a barrel, an editor's auto-import — would run the whole job and then
 * call `disconnectPrisma()` on the shared client, closing the pool underneath a
 * running API or worker. The three jobs that shipped this way were one stray
 * import away from that.
 *
 * The catch is not decoration either: `void main().finally(...)` leaves a
 * rejected promise with no handler, which is precisely the "[worker] unhandled
 * rejection" line this pass exists to remove.
 */
if (isMainModule(import.meta.url)) {
  main()
    .catch((err) => {
      console.error("[leaderboard:recalculate] failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => void disconnectPrisma());
}

