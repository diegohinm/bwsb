import type { Prisma, BetLegs, BetSnapshots, Bets } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import type {
  Bet,
  BetLeg,
  BetSnapshot,
  BetStatus,
  Direction,
  Instrument,
  Moneyness,
  OptionType,
  PositionIntent,
  VerificationLevel,
} from "../types/domain.js";
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
  /** Only bets extracted at or after this instant. */
  since?: Date;
  /** Only bets whose source post came from one of these communities. */
  subreddits?: string[];
  limit?: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How much a bet has been proven, weakest to strongest. */
export const VERIFICATION_RANK: Record<string, number> = {
  unverified: 0,
  text_only: 1,
  screenshot_detected: 2,
  internally_consistent: 3,
  market_validated: 4,
  follow_up_verified: 5,
};

/** True when the caller narrowed the feed (so an empty result is intentional). */
function hasFilters(f: BetFilters): boolean {
  return Boolean(
    f.ticker ||
      f.optionType ||
      f.verificationLevel ||
      f.status ||
      f.positionIntent ||
      f.since ||
      f.subreddits?.length ||
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

// ── Row mapping ──────────────────────────────────────────────────────────────
// The domain types (and the demo fallback rows they share the wire with) are
// snake_case with real numbers and ISO strings, so Decimal/Date columns are
// converted once here rather than leaking Prisma types into routes.

/** A `date` column carries no time — render it as YYYY-MM-DD, like the demo rows. */
function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toBet(r: Bets): Bet {
  return {
    id: r.id,
    source_type: r.sourceType,
    reddit_post_id: r.redditPostId,
    reddit_comment_id: r.redditCommentId,
    author_hash: r.authorHash,
    ticker: r.ticker,
    direction: r.direction as Direction | null,
    instrument: r.instrument as Instrument | null,
    option_type: r.optionType as OptionType | null,
    position_intent: r.positionIntent as PositionIntent | null,
    status: r.status as BetStatus | null,
    declared_capital: num(r.declaredCapital),
    verified_capital: num(r.verifiedCapital),
    notional_exposure: num(r.notionalExposure),
    max_loss: num(r.maxLoss),
    max_gain: num(r.maxGain),
    breakeven: num(r.breakeven),
    entry_underlying_price: num(r.entryUnderlyingPrice),
    entry_timestamp: r.entryTimestamp ? r.entryTimestamp.toISOString() : null,
    extraction_confidence: num(r.extractionConfidence),
    verification_level: r.verificationLevel as VerificationLevel | null,
    raw_evidence: r.rawEvidence,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function toLeg(r: BetLegs): BetLeg {
  return {
    id: r.id,
    bet_id: r.betId ?? "",
    leg_type: r.legType as BetLeg["leg_type"],
    side: r.side as BetLeg["side"],
    option_type: r.optionType as OptionType | null,
    strike: num(r.strike),
    expiration_date: dateOnly(r.expirationDate),
    contracts: r.contracts,
    shares: num(r.shares),
    premium: num(r.premium),
    price: num(r.price),
    dte: r.dte,
    moneyness: r.moneyness as Moneyness | null,
    delta: num(r.delta),
    theta: num(r.theta),
    vega: num(r.vega),
    implied_volatility: num(r.impliedVolatility),
    bid: num(r.bid),
    ask: num(r.ask),
    mid: num(r.mid),
    created_at: r.createdAt.toISOString(),
  };
}

function toSnapshot(r: BetSnapshots): BetSnapshot {
  return {
    id: r.id,
    bet_id: r.betId ?? "",
    snapshot_at: r.snapshotAt.toISOString(),
    underlying_price: num(r.underlyingPrice),
    estimated_option_value: num(r.estimatedOptionValue),
    estimated_position_value: num(r.estimatedPositionValue),
    return_pct: num(r.returnPct),
    unrealized_pl: num(r.unrealizedPl),
    max_gain_so_far: num(r.maxGainSoFar),
    max_loss_so_far: num(r.maxLossSoFar),
    metadata: r.metadata,
  };
}

/** Round to 2dp the way `round(… ::numeric, 2)` did in SQL. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Descending sort that keeps nulls last, matching `ORDER BY … DESC NULLS LAST`. */
function byDescNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Data access for structured bets and their legs / snapshots / performance. */
export const betsRepository = {
  async list(filters: BetFilters = {}): Promise<Bet[]> {
    const where: Prisma.BetsWhereInput = {
      ...(filters.ticker ? { ticker: filters.ticker.toUpperCase() } : {}),
      ...(filters.optionType ? { optionType: filters.optionType } : {}),
      ...(filters.verificationLevel
        ? { verificationLevel: filters.verificationLevel }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.positionIntent ? { positionIntent: filters.positionIntent } : {}),
      ...(typeof filters.minDeclaredCapital === "number"
        ? { declaredCapital: { gte: filters.minDeclaredCapital } }
        : {}),
      ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
      // Community filtering travels through the source post — a bet has no
      // subreddit of its own, it inherits the one it was extracted from.
      ...(filters.subreddits?.length
        ? { redditPosts: { subreddit: { in: filters.subreddits } } }
        : {}),
    };

    return safe(
      "list",
      async () => {
        const rows = await prisma.bets.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: filters.limit ?? 100,
        });
        // Fresh / unseeded DB: keep the public feed useful with labeled demo
        // data rather than an empty page. A narrowed (filtered) query respects
        // an empty result — the user filtered to nothing on purpose.
        if (rows.length === 0 && !hasFilters(filters)) return filterDemoBets(filters);
        return rows.map(toBet);
      },
      () => filterDemoBets(filters),
    );
  },

  async findById(id: string): Promise<Bet | null> {
    // Guard non-UUID ids: Postgres would throw "invalid input syntax for type
    // uuid" (→ 500). Return the demo bet so the route answers cleanly instead.
    if (!UUID_RE.test(id)) return demoBetById(id);
    return safe(
      "findById",
      async () => {
        const row = await prisma.bets.findUnique({ where: { id } });
        return row ? toBet(row) : demoBetById(id);
      },
      () => demoBetById(id),
    );
  },

  legsForBet(betId: string): Promise<BetLeg[]> {
    if (!UUID_RE.test(betId)) return Promise.resolve(demoLegsForBet(betId));
    return safe(
      "legsForBet",
      async () =>
        (
          await prisma.betLegs.findMany({
            where: { betId },
            orderBy: { expirationDate: "asc" },
          })
        ).map(toLeg),
      () => demoLegsForBet(betId),
    );
  },

  snapshotsForBet(betId: string): Promise<BetSnapshot[]> {
    if (!UUID_RE.test(betId)) return Promise.resolve([]);
    return safe(
      "snapshotsForBet",
      async () =>
        (
          await prisma.betSnapshots.findMany({
            where: { betId },
            orderBy: { snapshotAt: "asc" },
          })
        ).map(toSnapshot),
      () => [],
    );
  },

  performanceForBet(betId: string) {
    if (!UUID_RE.test(betId)) return Promise.resolve(null);
    return safe(
      "performanceForBet",
      () =>
        prisma.betPerformance.findFirst({
          where: { betId },
          orderBy: { createdAt: "desc" },
        }),
      () => null,
    );
  },

  verificationsForBet(betId: string) {
    if (!UUID_RE.test(betId)) return Promise.resolve([]);
    return safe(
      "verificationsForBet",
      () =>
        prisma.betVerifications.findMany({
          where: { betId },
          orderBy: { createdAt: "asc" },
        }),
      () => [],
    );
  },

  lifecycleForBet(betId: string) {
    if (!UUID_RE.test(betId)) return Promise.resolve([]);
    return safe(
      "lifecycleForBet",
      () =>
        prisma.betLifecycleEvents.findMany({
          where: { betId },
          orderBy: { occurredAt: "asc" },
        }),
      () => [],
    );
  },

  forTicker(ticker: string): Promise<Bet[]> {
    return safe(
      "forTicker",
      async () =>
        (
          await prisma.bets.findMany({
            where: { ticker },
            orderBy: { declaredCapital: { sort: "desc", nulls: "last" } },
          })
        ).map(toBet),
      () => filterDemoBets({ ticker }),
    );
  },

  /**
   * Leaderboard by latest snapshot return, joined to anonymized author reputation.
   *
   * The lateral "newest snapshot per bet" join is expressed as a nested `take: 1`.
   * Author reputation needs a second lookup: bets.author_hash has no foreign key
   * to anonymized_authors, so Prisma has no relation to traverse. Ranking happens
   * here rather than in SQL because it sorts on the joined snapshot's return_pct.
   */
  leaderboard(limit = 20) {
    return safe(
      "leaderboard",
      async () => {
        const bets = await prisma.bets.findMany({
          select: {
            id: true,
            ticker: true,
            optionType: true,
            declaredCapital: true,
            verificationLevel: true,
            authorHash: true,
            betSnapshots: {
              select: { returnPct: true, unrealizedPl: true },
              orderBy: { snapshotAt: "desc" },
              take: 1,
            },
          },
        });
        if (bets.length === 0) return [];

        const authorHashes = [
          ...new Set(bets.map((b) => b.authorHash).filter((h): h is string => h !== null)),
        ];
        const authors = authorHashes.length
          ? await prisma.anonymizedAuthors.findMany({
              where: { authorHash: { in: authorHashes } },
              select: { authorHash: true, reputationScore: true, hitRate: true },
            })
          : [];
        const byAuthor = new Map(authors.map((a) => [a.authorHash, a]));

        return bets
          .map((b) => {
            const author = b.authorHash ? byAuthor.get(b.authorHash) : undefined;
            const snapshot = b.betSnapshots[0];
            return {
              id: b.id,
              ticker: b.ticker,
              option_type: b.optionType,
              declared_capital: num(b.declaredCapital),
              verification_level: b.verificationLevel,
              author_hash: b.authorHash,
              reputation_score: num(author?.reputationScore ?? null),
              hit_rate: num(author?.hitRate ?? null),
              return_pct: num(snapshot?.returnPct ?? null),
              unrealized_pl: num(snapshot?.unrealizedPl ?? null),
            };
          })
          .sort((a, b) => byDescNullsLast(a.return_pct, b.return_pct))
          .slice(0, limit);
      },
      () => [],
    );
  },

  /**
   * Highest verification level reached per ticker, as a rank (0–5).
   *
   * Replaces `max(CASE verification_level …)` — the ordering is a property of
   * the levels, not of the strings, so it lives in code next to the levels.
   */
  async verificationRankByTicker(): Promise<Map<string, number>> {
    return safe(
      "verificationRankByTicker",
      async () => {
        const rows = await prisma.bets.findMany({
          select: { ticker: true, verificationLevel: true },
        });

        const ranks = new Map<string, number>();
        for (const row of rows) {
          if (!row.ticker) continue;
          const rank = VERIFICATION_RANK[row.verificationLevel ?? ""] ?? 0;
          ranks.set(row.ticker, Math.max(ranks.get(row.ticker) ?? 0, rank));
        }
        return ranks;
      },
      () => new Map<string, number>(),
    );
  },

  /** Expiration calendar: contracts and premium grouped by expiration date. */
  expirationCalendar() {
    return safe(
      "expirationCalendar",
      async () => {
        // Grouped in memory because the grouping key spans two tables
        // (bet_legs.expiration_date + bets.ticker), which Prisma's groupBy
        // cannot join across.
        const legs = await prisma.betLegs.findMany({
          where: { expirationDate: { not: null } },
          select: {
            expirationDate: true,
            contracts: true,
            premium: true,
            bets: { select: { ticker: true } },
          },
        });

        const groups = new Map<
          string,
          { expiration_date: string; ticker: string | null; contracts: number; premium_at_risk: number }
        >();

        for (const leg of legs) {
          const expiration = dateOnly(leg.expirationDate);
          if (expiration === null) continue;
          const ticker = leg.bets?.ticker ?? null;
          const key = `${expiration}|${ticker ?? ""}`;

          const group =
            groups.get(key) ??
            { expiration_date: expiration, ticker, contracts: 0, premium_at_risk: 0 };
          group.contracts += leg.contracts ?? 0;
          group.premium_at_risk += (leg.contracts ?? 0) * (num(leg.premium) ?? 0) * 100;
          groups.set(key, group);
        }

        return [...groups.values()]
          .map((g) => ({ ...g, premium_at_risk: round2(g.premium_at_risk) }))
          .sort((a, b) => a.expiration_date.localeCompare(b.expiration_date));
      },
      () => [],
    );
  },

  /** Collective realized/unrealized P/L across the latest snapshot of every bet. */
  collectivePl() {
    return safe(
      "collectivePl",
      async () => {
        const bets = await prisma.bets.findMany({
          select: {
            ticker: true,
            declaredCapital: true,
            betSnapshots: {
              select: { unrealizedPl: true, returnPct: true },
              orderBy: { snapshotAt: "desc" },
              take: 1,
            },
          },
        });

        const groups = new Map<
          string,
          {
            ticker: string | null;
            bets: number;
            declared_capital: number;
            unrealized_pl: number;
            returnSum: number;
            returnCount: number;
          }
        >();

        for (const bet of bets) {
          const key = bet.ticker ?? "";
          const group =
            groups.get(key) ??
            {
              ticker: bet.ticker,
              bets: 0,
              declared_capital: 0,
              unrealized_pl: 0,
              returnSum: 0,
              returnCount: 0,
            };

          group.bets += 1;
          group.declared_capital += num(bet.declaredCapital) ?? 0;

          const snapshot = bet.betSnapshots[0];
          group.unrealized_pl += num(snapshot?.unrealizedPl ?? null) ?? 0;
          // avg() ignores NULLs, so only bets with a snapshot return count.
          const returnPct = num(snapshot?.returnPct ?? null);
          if (returnPct !== null) {
            group.returnSum += returnPct;
            group.returnCount += 1;
          }

          groups.set(key, group);
        }

        return [...groups.values()]
          .map((g) => ({
            ticker: g.ticker,
            bets: g.bets,
            declared_capital: round2(g.declared_capital),
            unrealized_pl: round2(g.unrealized_pl),
            avg_return_pct: g.returnCount > 0 ? round2(g.returnSum / g.returnCount) : null,
          }))
          .sort((a, b) => b.unrealized_pl - a.unrealized_pl);
      },
      () => [],
    );
  },
};
