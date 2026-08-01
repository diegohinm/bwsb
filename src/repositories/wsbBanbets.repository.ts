import { prisma } from "../lib/prisma.js";
import { num } from "../lib/numeric.js";
import type {
  BanbetOperator,
  BanbetSide,
  BanbetStatus,
  WsbBanbet,
} from "../services/wsb/wsb.types.js";

/**
 * Banbet storage.
 *
 *   WORKER writes: upsertBanbets, expireDueBanbets
 *   API reads:     readResolvedBanbets, readExpiringBanbets, readBanbetsForUser
 *
 * A banbet is a LIVE record, not a snapshot: it is created open and later moves
 * to won/lost/expired, so `external_id` keys an upsert instead of appending a
 * new row per run. Re-ingesting the same window is therefore idempotent.
 *
 * Identity is stored hashed. `display_username` is written only when the source
 * permits showing the handle, and the read layer falls back to an anonymous
 * label rather than leaking the hash.
 */

export interface BanbetInput {
  externalId: string;
  usernameHash: string;
  displayUsername: string | null;
  appUserId?: string | null;
  ticker: string;
  operator: BanbetOperator;
  targetPrice: number;
  side: BanbetSide;
  status: BanbetStatus;
  resultPct: number | null;
  sourceUrl: string | null;
  subreddit: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  provider: string;
  source: string;
  isMock: boolean;
}

// ── Worker writes ────────────────────────────────────────────────────────────

/**
 * Upsert a batch of banbets. Written one at a time and not wrapped in a
 * transaction: a single malformed record must not discard a whole run.
 */
export async function upsertBanbets(rows: BanbetInput[]): Promise<number> {
  let written = 0;
  for (const r of rows) {
    await prisma.wsbBanbets.upsert({
      where: { externalId: r.externalId },
      create: {
        externalId: r.externalId,
        usernameHash: r.usernameHash,
        displayUsername: r.displayUsername,
        appUserId: r.appUserId ?? null,
        ticker: r.ticker,
        operator: r.operator,
        targetPrice: r.targetPrice,
        side: r.side,
        status: r.status,
        resultPct: r.resultPct,
        sourceUrl: r.sourceUrl,
        subreddit: r.subreddit,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        resolvedAt: r.resolvedAt,
        provider: r.provider,
        source: r.source,
        isMock: r.isMock,
      },
      // Only lifecycle fields move. The terms of a bet (ticker, target,
      // operator, side, creation) are fixed the moment it is placed — rewriting
      // them from a later fetch would silently rewrite history.
      update: {
        status: r.status,
        resultPct: r.resultPct,
        resolvedAt: r.resolvedAt,
        displayUsername: r.displayUsername,
        fetchedAt: new Date(),
      },
    });
    written += 1;
  }
  return written;
}

/**
 * Move past-deadline open bets to `expired`.
 *
 * This is a clock transition, not a price judgement: an unresolved bet whose
 * deadline passed is expired, never "lost". Deciding won/lost requires the
 * price at expiry, which is the resolver's job, not this one's.
 */
export async function expireDueBanbets(now: Date = new Date()): Promise<number> {
  const res = await prisma.wsbBanbets.updateMany({
    where: { status: "open", expiresAt: { lt: now } },
    data: { status: "expired", resolvedAt: now },
  });
  return res.count;
}

// ── API reads ────────────────────────────────────────────────────────────────

type BanbetRow = Awaited<ReturnType<typeof prisma.wsbBanbets.findFirst>>;

/**
 * Never expose the username hash. A source that does not allow showing handles
 * yields a stable anonymous label instead.
 */
function displayFor(row: NonNullable<BanbetRow>): string {
  return row.displayUsername?.trim() || "Anonymous trader";
}

function toBanbet(row: NonNullable<BanbetRow>): WsbBanbet {
  return {
    id: row.id,
    username: displayFor(row),
    ticker: row.ticker,
    operator: row.operator as BanbetOperator,
    targetPrice: num(row.targetPrice) ?? 0,
    side: row.side as BanbetSide,
    status: row.status as BanbetStatus,
    resultPct: num(row.resultPct),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    subreddit: row.subreddit,
    sourceUrl: row.sourceUrl,
  };
}

export interface BanbetFilters {
  ticker?: string;
  side?: BanbetSide;
  limit: number;
  skip?: number;
}

/** Resolved bets, newest resolution first. */
export async function readResolvedBanbets(f: BanbetFilters): Promise<WsbBanbet[]> {
  const rows = await prisma.wsbBanbets.findMany({
    where: {
      status: { in: ["won", "lost", "expired"] },
      ...(f.ticker ? { ticker: f.ticker.toUpperCase() } : {}),
      ...(f.side ? { side: f.side } : {}),
    },
    orderBy: [{ resolvedAt: { sort: "desc", nulls: "last" } }, { expiresAt: "desc" }],
    skip: f.skip ?? 0,
    take: f.limit,
  });
  return rows.map(toBanbet);
}

/**
 * Open bets ordered by NEAREST deadline — that ordering is the whole point of
 * the section, so it lives in the query rather than in the client.
 */
export async function readExpiringBanbets(
  f: BanbetFilters,
  now: Date = new Date(),
): Promise<WsbBanbet[]> {
  const rows = await prisma.wsbBanbets.findMany({
    where: {
      status: "open",
      expiresAt: { gte: now },
      ...(f.ticker ? { ticker: f.ticker.toUpperCase() } : {}),
      ...(f.side ? { side: f.side } : {}),
    },
    orderBy: { expiresAt: "asc" },
    skip: f.skip ?? 0,
    take: f.limit,
  });
  return rows.map(toBanbet);
}

/** Every banbet belonging to one YOLOPulse account. */
export async function readBanbetsForUser(
  appUserId: string,
  limit: number,
): Promise<WsbBanbet[]> {
  const rows = await prisma.wsbBanbets.findMany({
    where: { appUserId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toBanbet);
}

export interface BanbetStanding {
  username: string;
  wins: number;
  losses: number;
  expired: number;
  resolved: number;
  winRatePct: number;
  /** Average result across resolved bets, null when none carried a result. */
  avgResultPct: number | null;
}

/**
 * Standings across resolved banbets.
 *
 * Ranked by WINS first and win-rate second: one lucky 1-for-1 call must not
 * outrank a trader who resolved thirty. Only resolved bets count — an open bet
 * has no outcome to score. Aggregated over the most recent `sampleSize`
 * resolutions so the query stays bounded on a table that only grows.
 */
export async function readBanbetLeaderboard(
  limit: number,
  sampleSize = 2_000,
): Promise<BanbetStanding[]> {
  const rows = await prisma.wsbBanbets.findMany({
    where: { status: { in: ["won", "lost", "expired"] } },
    orderBy: [{ resolvedAt: { sort: "desc", nulls: "last" } }],
    take: sampleSize,
    select: {
      usernameHash: true,
      displayUsername: true,
      status: true,
      resultPct: true,
    },
  });

  type Acc = {
    username: string;
    wins: number;
    losses: number;
    expired: number;
    resultSum: number;
    resultCount: number;
  };
  const byUser = new Map<string, Acc>();

  for (const r of rows) {
    let acc = byUser.get(r.usernameHash);
    if (!acc) {
      acc = {
        username: r.displayUsername?.trim() || "Anonymous trader",
        wins: 0,
        losses: 0,
        expired: 0,
        resultSum: 0,
        resultCount: 0,
      };
      byUser.set(r.usernameHash, acc);
    }
    if (r.status === "won") acc.wins += 1;
    else if (r.status === "lost") acc.losses += 1;
    else acc.expired += 1;

    const result = num(r.resultPct);
    if (result !== null) {
      acc.resultSum += result;
      acc.resultCount += 1;
    }
  }

  return [...byUser.values()]
    .map((a) => {
      const resolved = a.wins + a.losses + a.expired;
      return {
        username: a.username,
        wins: a.wins,
        losses: a.losses,
        expired: a.expired,
        resolved,
        winRatePct: resolved > 0 ? Math.round((a.wins / resolved) * 1000) / 10 : 0,
        avgResultPct:
          a.resultCount > 0 ? Math.round((a.resultSum / a.resultCount) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.wins - a.wins || b.winRatePct - a.winRatePct || b.resolved - a.resolved)
    .slice(0, limit);
}

/** Provenance of the freshest stored banbet, for the response envelope. */
export async function readBanbetsMeta(): Promise<{
  provider: string;
  source: string;
  isMock: boolean;
  updatedAt: string | null;
} | null> {
  const row = await prisma.wsbBanbets.findFirst({ orderBy: { fetchedAt: "desc" } });
  if (!row) return null;
  return {
    provider: row.provider ?? "mock",
    source: row.source ?? row.provider ?? "mock",
    isMock: row.isMock,
    updatedAt: row.fetchedAt.toISOString(),
  };
}

/** True when any stored banbet is real data — drives the demo badge. */
export async function hasRealBanbets(): Promise<boolean> {
  const real = await prisma.wsbBanbets.count({ where: { isMock: false } });
  return real > 0;
}
