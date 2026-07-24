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
   *
   * Participants key off public.app_users (uuid) — the email-auth identity that
   * sessions are issued against — so the username is resolved from app_users
   * (verified Reddit handle → display name → email local-part), NOT the legacy
   * public.users table (whose text id is a different type and would throw
   * `operator does not exist: text = uuid`).
   */
  leaderboard(competitionId: string) {
    return query(
      `SELECT p.user_id,
              COALESCE(ra.reddit_username, au.display_name, split_part(au.email, '@', 1)) AS username,
              va.equity_value,
              va.starting_cash,
              round((( (va.equity_value - va.starting_cash) / NULLIF(va.starting_cash,0) ) * 100)::numeric, 2) AS return_pct,
              rank() OVER (ORDER BY va.equity_value DESC) AS rank
       FROM public.competition_participants p
       JOIN public.virtual_accounts va ON va.id = p.virtual_account_id
       LEFT JOIN public.app_users au ON au.id = p.user_id
       LEFT JOIN LATERAL (
         SELECT reddit_username
           FROM public.reddit_accounts
          WHERE user_id = p.user_id AND verification_status = 'verified'
          ORDER BY updated_at DESC
          LIMIT 1
       ) ra ON true
       WHERE p.competition_id = $1
       ORDER BY va.equity_value DESC`,
      [competitionId],
    );
  },
};
