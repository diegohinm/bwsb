import { query, queryOne } from "../lib/db.js";

/** Data access for competitions, participants and leaderboard. */
export const competitionRepository = {
  activeCompetition() {
    return queryOne(
      `SELECT * FROM public.competitions WHERE is_active = true
       ORDER BY created_at ASC LIMIT 1`,
    );
  },

  participant(competitionId: string, userId: string) {
    return queryOne(
      `SELECT * FROM public.competition_participants
       WHERE competition_id = $1 AND user_id = $2`,
      [competitionId, userId],
    );
  },

  join(competitionId: string, userId: string, virtualAccountId: string) {
    return queryOne(
      `INSERT INTO public.competition_participants (competition_id, user_id, virtual_account_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (competition_id, user_id) DO UPDATE SET virtual_account_id = EXCLUDED.virtual_account_id
       RETURNING *`,
      [competitionId, userId, virtualAccountId],
    );
  },

  /**
   * Live leaderboard computed from each participant's virtual account equity,
   * ranked by return vs the competition's starting cash.
   */
  leaderboard(competitionId: string) {
    return query(
      `SELECT p.user_id,
              u.reddit_username AS username,
              va.equity_value,
              va.starting_cash,
              round((( (va.equity_value - va.starting_cash) / NULLIF(va.starting_cash,0) ) * 100)::numeric, 2) AS return_pct,
              rank() OVER (ORDER BY va.equity_value DESC) AS rank
       FROM public.competition_participants p
       JOIN public.virtual_accounts va ON va.id = p.virtual_account_id
       LEFT JOIN public.users u ON u.id = p.user_id
       WHERE p.competition_id = $1
       ORDER BY va.equity_value DESC`,
      [competitionId],
    );
  },
};
