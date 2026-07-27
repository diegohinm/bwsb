import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";

/** Data access for competitions, participants and leaderboard. */
export const competitionRepository = {
  activeCompetition() {
    return prisma.competitions.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    });
  },

  participant(competitionId: string, userId: string) {
    return prisma.competitionParticipants.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
    });
  },

  join(competitionId: string, userId: string, virtualAccountId: string) {
    return prisma.competitionParticipants.upsert({
      where: { competitionId_userId: { competitionId, userId } },
      create: { competitionId, userId, virtualAccountId },
      // Re-joining repoints the entry at the caller's current virtual account.
      update: { virtualAccountId },
    });
  },

  /**
   * Live leaderboard computed from each participant's virtual account equity,
   * ranked by return vs the competition's starting cash.
   *
   * Participants key off public.app_users (uuid) — the email-auth identity that
   * sessions are issued against — so the username is resolved from app_users
   * (verified Reddit handle → display name → email local-part), NOT the legacy
   * public.users table (whose text id is a different type).
   *
   * The verified-Reddit-handle lookup was a LATERAL join; Prisma expresses it as
   * a filtered nested read, and the rank() window function is applied here after
   * ordering by equity.
   */
  async leaderboard(competitionId: string) {
    const participants = await prisma.competitionParticipants.findMany({
      where: { competitionId, virtualAccounts: { isNot: null } },
      select: {
        userId: true,
        virtualAccounts: { select: { equityValue: true, startingCash: true } },
        appUsers: {
          select: {
            displayName: true,
            email: true,
            redditAccounts: {
              where: { verificationStatus: "verified" },
              select: { redditUsername: true },
              orderBy: { updatedAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    const rows = participants
      // The JOIN on virtual_accounts was an inner join: no account, no entry.
      .filter((p) => p.virtualAccounts !== null)
      .map((p) => {
        const equityValue = num(p.virtualAccounts!.equityValue) ?? 0;
        const startingCash = num(p.virtualAccounts!.startingCash) ?? 0;
        // NULLIF(starting_cash, 0): dividing by a zero float would give ±Infinity.
        const returnPct =
          startingCash === 0
            ? null
            : Math.round(((equityValue - startingCash) / startingCash) * 100 * 100) / 100;

        return {
          user_id: p.userId,
          username:
            p.appUsers?.redditAccounts[0]?.redditUsername ??
            p.appUsers?.displayName ??
            p.appUsers?.email.split("@")[0] ??
            null,
          equity_value: equityValue,
          starting_cash: startingCash,
          return_pct: returnPct,
          rank: 0,
        };
      })
      .sort((a, b) => b.equity_value - a.equity_value);

    // rank() OVER (ORDER BY equity_value DESC): ties share a rank, and the next
    // rank skips the tied entries.
    let rank = 0;
    let previousEquity: number | null = null;
    return rows.map((row, index) => {
      if (previousEquity === null || row.equity_value !== previousEquity) {
        rank = index + 1;
        previousEquity = row.equity_value;
      }
      return { ...row, rank };
    });
  },
};
