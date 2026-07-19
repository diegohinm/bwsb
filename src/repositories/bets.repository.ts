import { query, queryOne } from "../lib/db.js";
import type { Bet, BetLeg, BetSnapshot } from "../types/domain.js";

export interface BetFilters {
  ticker?: string;
  optionType?: string;
  verificationLevel?: string;
  status?: string;
  positionIntent?: string;
  minDeclaredCapital?: number;
  limit?: number;
}

/** Data access for structured bets and their legs / snapshots / performance. */
export const betsRepository = {
  list(filters: BetFilters = {}): Promise<Bet[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const add = (clause: string, value: unknown) => {
      params.push(value);
      conditions.push(clause.replace("$?", `$${params.length}`));
    };

    if (filters.ticker) add("ticker = $?", filters.ticker.toUpperCase());
    if (filters.optionType) add("option_type = $?", filters.optionType);
    if (filters.verificationLevel)
      add("verification_level = $?", filters.verificationLevel);
    if (filters.status) add("status = $?", filters.status);
    if (filters.positionIntent) add("position_intent = $?", filters.positionIntent);
    if (typeof filters.minDeclaredCapital === "number")
      add("declared_capital >= $?", filters.minDeclaredCapital);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(filters.limit ?? 100);

    return query<Bet>(
      `SELECT * FROM public.bets ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
  },

  findById(id: string): Promise<Bet | null> {
    return queryOne<Bet>(`SELECT * FROM public.bets WHERE id = $1`, [id]);
  },

  legsForBet(betId: string): Promise<BetLeg[]> {
    return query<BetLeg>(
      `SELECT * FROM public.bet_legs WHERE bet_id = $1 ORDER BY expiration_date ASC`,
      [betId],
    );
  },

  snapshotsForBet(betId: string): Promise<BetSnapshot[]> {
    return query<BetSnapshot>(
      `SELECT * FROM public.bet_snapshots WHERE bet_id = $1 ORDER BY snapshot_at ASC`,
      [betId],
    );
  },

  performanceForBet(betId: string) {
    return queryOne(
      `SELECT * FROM public.bet_performance WHERE bet_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [betId],
    );
  },

  verificationsForBet(betId: string) {
    return query(
      `SELECT * FROM public.bet_verifications WHERE bet_id = $1 ORDER BY created_at ASC`,
      [betId],
    );
  },

  lifecycleForBet(betId: string) {
    return query(
      `SELECT * FROM public.bet_lifecycle_events WHERE bet_id = $1 ORDER BY occurred_at ASC`,
      [betId],
    );
  },

  forTicker(ticker: string): Promise<Bet[]> {
    return query<Bet>(
      `SELECT * FROM public.bets WHERE ticker = $1 ORDER BY declared_capital DESC NULLS LAST`,
      [ticker],
    );
  },

  /** Leaderboard by latest snapshot return, joined to anonymized author reputation. */
  leaderboard(limit = 20) {
    return query(
      `SELECT b.id, b.ticker, b.option_type, b.declared_capital, b.verification_level,
              b.author_hash, a.reputation_score, a.hit_rate,
              s.return_pct, s.unrealized_pl
       FROM public.bets b
       LEFT JOIN LATERAL (
         SELECT return_pct, unrealized_pl FROM public.bet_snapshots
         WHERE bet_id = b.id ORDER BY snapshot_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN public.anonymized_authors a ON a.author_hash = b.author_hash
       ORDER BY s.return_pct DESC NULLS LAST
       LIMIT $1`,
      [limit],
    );
  },

  /** Expiration calendar: contracts and premium grouped by expiration date. */
  expirationCalendar() {
    return query(
      `SELECT l.expiration_date, b.ticker,
              sum(l.contracts)::int AS contracts,
              round(sum(l.contracts * l.premium * 100)::numeric, 2) AS premium_at_risk
       FROM public.bet_legs l
       JOIN public.bets b ON b.id = l.bet_id
       WHERE l.expiration_date IS NOT NULL
       GROUP BY l.expiration_date, b.ticker
       ORDER BY l.expiration_date ASC`,
    );
  },

  /** Collective realized/unrealized P/L across the latest snapshot of every bet. */
  collectivePl() {
    return query(
      `SELECT b.ticker,
              count(*)::int AS bets,
              round(sum(coalesce(b.declared_capital,0))::numeric, 2) AS declared_capital,
              round(sum(coalesce(s.unrealized_pl,0))::numeric, 2) AS unrealized_pl,
              round(avg(s.return_pct)::numeric, 2) AS avg_return_pct
       FROM public.bets b
       LEFT JOIN LATERAL (
         SELECT unrealized_pl, return_pct FROM public.bet_snapshots
         WHERE bet_id = b.id ORDER BY snapshot_at DESC LIMIT 1
       ) s ON true
       GROUP BY b.ticker
       ORDER BY unrealized_pl DESC`,
    );
  },
};
