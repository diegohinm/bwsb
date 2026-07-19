/**
 * competition.service.ts
 *
 * Paper-trading league. Users join with their virtual account; the leaderboard
 * ranks participants by virtual equity / return. Virtual money only.
 */
import { competitionRepository } from "../../repositories/competition.repository.js";
import { ensureAccount } from "../portfolio/virtualAccount.service.js";

/** The active competition, the leaderboard, and whether this user has joined. */
export async function getCompetitionView(userId?: string) {
  const competition = await competitionRepository.activeCompetition();
  if (!competition) {
    return { competition: null, leaderboard: [], joined: false, my_rank: null };
  }

  const leaderboard = (await competitionRepository.leaderboard(competition.id)) as Array<{
    user_id: string;
    rank: number;
  }>;

  let joined = false;
  let myRank: number | null = null;
  if (userId) {
    const p = await competitionRepository.participant(competition.id, userId);
    joined = Boolean(p);
    const mine = leaderboard.find((row) => row.user_id === userId);
    myRank = mine ? Number(mine.rank) : null;
  }

  return { competition, leaderboard, joined, my_rank: myRank };
}

/** Join the active competition, creating the user's virtual account if needed. */
export async function joinActiveCompetition(userId: string) {
  const competition = await competitionRepository.activeCompetition();
  if (!competition) throw new Error("No active competition to join");

  const account = await ensureAccount(userId);
  const participant = await competitionRepository.join(
    competition.id as string,
    userId,
    account.id,
  );
  return { competition, participant };
}
