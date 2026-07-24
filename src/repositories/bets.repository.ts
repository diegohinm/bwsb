import { query, queryOne } from "../lib/db.js";
import type { Bet, BetLeg, BetSnapshot } from "../types/domain.js";
import {
  demoBetById,
  demoLegsForBet,
  filterDemoBets,
} from "../config/demoBets.js";

export interface BetFilters {
  ticker?: string;
  optionType?: string;
  verificationLevel?: string;
  status?: string;
  positionIntent?: string;
  minDeclaredCapital?: number;
  limit?: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the caller narrowed the feed (so an empty result is intentional). */
function hasFilters(f: BetFilters): boolean {
  return Boolean(
    f.ticker ||
      f.optionType ||
      f.verificationLevel ||
      f.status ||
      f.positionIntent ||
      typeof f.minDeclaredCapital === "number",
  );
}

/**
 * Run a DB read; on failure fall back to a value instead of throwing, so a
 * transient pooler hiccup / missing table never turns a public read endpoint
 * into a 500. Mirrors the resilience pattern used by search/overview.
 */
async function safe<T>(label: string, run: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.warn(`[bets] ${label} failed, serving demo/empty fallback:`, (err as Error).message);
    return fallback();
  }
}

/** Data access for structured bets and their legs / snapshots / performance. */
export const betsRepository = {
  async list(filters: BetFilters = {}): Promise<Bet[]> {
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

    return safe(
      "list",
      async () => {
        const rows = await query<Bet>(
          `SELECT * FROM public.bets ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
          params,
        );
        // Fresh / unseeded DB: keep the public feed useful with labeled demo
        // data rather than an empty page. A narrowed (filtered) query respects
        // an empty result — the user filtered to nothing on purpose.
        if (rows.length === 0 && !hasFilters(filters)) return filterDemoBets(filters);
        return rows;
      },
      () => filterDemoBets(filters),
    );
  },

  async findById(id: string): Promise<Bet | null> {
    // Guard non-UUID ids: Postgres would throw "invalid input syntax for type
    // uuid" (→ 500). Return null so the route answers a clean 404 instead.
    if (!UUID_RE.test(id)) return demoBetById(id);
    return safe(
      "findById",
      async () => (await queryOne<Bet>(`SELECT * FROM public.bets WHERE id = $1`, [id])) ?? demoBetById(id),
      () => demoBetById(id),
    );
  },

  legsForBet(betId: string): Promise<BetLeg[]> {
    if (!UUID_RE.test(betId)) return Promise.resolve(demoLegsForBet(betId));
    return safe(
      "legsForBet",
      () =>
        query<BetLeg>(
          `SELECT * FROM public.bet_legs WHERE bet_id = $1 ORDER BY expiration_date ASC`,
          [betId],
        ),
      () => demoLegsForBet(betId),
    );
  },

  snapshotsForBet(betId: string): Promise<BetSnapshot[]> {
    if (!UUID_RE.test(betId)) return Promise.resolve([]);
    return safe(
      "snapshotsForBet",
      () =>
        query<BetSnapshot>(
          `SELECT * FROM public.bet_snapshots WHERE bet_id = $1 ORDER BY snapshot_at ASC`,
          [betId],
        ),
      () => [],
    );
  },

  performanceForBet(betId: string) {
    if (!UUID_RE.test(betId)) return Promise.resolve(null);
    return safe(
      "performanceForBet",
      () =>
        queryOne(
          `SELECT * FROM public.bet_performance WHERE bet_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [betId],
        ),
      () => null,
    );
  },

  verificationsForBet(betId: string) {
    if (!UUID_RE.test(betId)) return Promise.resolve([]);
    return safe(
      "verificationsForBet",
      () =>
        query(
          `SELECT * FROM public.bet_verifications WHERE bet_id = $1 ORDER BY created_at ASC`,
          [betId],
        ),
      () => [],
    );
  },

  lifecycleForBet(betId: string) {
    if (!UUID_RE.test(betId)) return Promise.resolve([]);
    return safe(
      "lifecycleForBet",
      () =>
        query(
          `SELECT * FROM public.bet_lifecycle_events WHERE bet_id = $1 ORDER BY occurred_at ASC`,
          [betId],
        ),
      () => [],
    );
  },

  forTicker(ticker: string): Promise<Bet[]> {
    return safe(
      "forTicker",
      () =>
        query<Bet>(
          `SELECT * FROM public.bets WHERE ticker = $1 ORDER BY declared_capital DESC NULLS LAST`,
          [ticker],
        ),
      () => filterDemoBets({ ticker }),
    );
  },

  /** Leaderboard by latest snapshot return, joined to anonymized author reputation. */
  leaderboard(limit = 20) {
    return safe("leaderboard", () => query(
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
    ), () => []);
  },

  /** Expiration calendar: contracts and premium grouped by expiration date. */
  expirationCalendar() {
    return safe("expirationCalendar", () => query(
      `SELECT l.expiration_date, b.ticker,
              sum(l.contracts)::int AS contracts,
              round(sum(l.contracts * l.premium * 100)::numeric, 2) AS premium_at_risk
       FROM public.bet_legs l
       JOIN public.bets b ON b.id = l.bet_id
       WHERE l.expiration_date IS NOT NULL
       GROUP BY l.expiration_date, b.ticker
       ORDER BY l.expiration_date ASC`,
    ), () => []);
  },

  /** Collective realized/unrealized P/L across the latest snapshot of every bet. */
  collectivePl() {
    return safe("collectivePl", () => query(
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
    ), () => []);
  },
};
