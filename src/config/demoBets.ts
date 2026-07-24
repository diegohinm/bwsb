import type { Bet, BetLeg } from "../types/domain.js";
import type { BetFilters } from "../repositories/bets.repository.js";

/**
 * Centralized DEMO bets — the labeled fallback served whenever the database is
 * unreachable / not yet seeded, so the public `/bets` feed and bet detail pages
 * never 5xx. This mirrors the ticker-catalog fallback used by search/overview.
 *
 * Every row carries `metadata.demo = true` so the frontend can badge it as
 * "Demo data" and never present it as a real, verified position. Ids match the
 * seed UUIDs so links stay stable whether a bet is real (seeded) or demo.
 *
 * Nothing here is scraped. Timestamps are computed relative to "now" at read
 * time (bucketed to the minute for stability) so ages read as recent instead of
 * stale absolute dates.
 */

interface DemoBetSpec {
  id: string;
  reddit_post_id: string;
  author_hash: string;
  ticker: string;
  direction: Bet["direction"];
  option_type: Bet["option_type"];
  status: Bet["status"];
  declared_capital: number;
  verified_capital: number;
  notional_exposure: number;
  max_loss: number;
  breakeven: number;
  entry_underlying_price: number;
  extraction_confidence: number;
  verification_level: Bet["verification_level"];
  text: string;
  /** How many minutes ago the position was opened. */
  minutesAgo: number;
  leg: {
    strike: number;
    expiration_date: string;
    contracts: number;
    premium: number;
    dte: number;
    moneyness: BetLeg["moneyness"];
    delta: number;
    implied_volatility: number;
  };
}

const SPECS: DemoBetSpec[] = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    reddit_post_id: "dev_post_rddt_001",
    author_hash: "dev_author_001",
    ticker: "RDDT",
    direction: "bullish",
    option_type: "call",
    status: "open",
    declared_capital: 2100,
    verified_capital: 2100,
    notional_exposure: 90000,
    max_loss: 2100,
    breakeven: 184.2,
    entry_underlying_price: 176.0,
    extraction_confidence: 0.86,
    verification_level: "internally_consistent",
    text: "bought 5 RDDT calls strike 180 exp Aug 21 premium 4.20",
    minutesAgo: 55,
    leg: { strike: 180, expiration_date: "2026-08-21", contracts: 5, premium: 4.2, dte: 33, moneyness: "OTM", delta: 0.48, implied_volatility: 0.62 },
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    reddit_post_id: "dev_post_poet_001",
    author_hash: "dev_author_002",
    ticker: "POET",
    direction: "bearish",
    option_type: "put",
    status: "open",
    declared_capital: 1200,
    verified_capital: 0,
    notional_exposure: 7500,
    max_loss: 1200,
    breakeven: 6.3,
    entry_underlying_price: 5.1,
    extraction_confidence: 0.74,
    verification_level: "text_only",
    text: "loading puts 7.5p 8/21 paid 1.20",
    minutesAgo: 45,
    leg: { strike: 7.5, expiration_date: "2026-08-21", contracts: 10, premium: 1.2, dte: 33, moneyness: "ITM", delta: -0.42, implied_volatility: 0.95 },
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    reddit_post_id: "dev_post_mu_001",
    author_hash: "dev_author_003",
    ticker: "MU",
    direction: "bullish",
    option_type: "call",
    status: "open",
    declared_capital: 2250,
    verified_capital: 2250,
    notional_exposure: 45000,
    max_loss: 2250,
    breakeven: 157.5,
    entry_underlying_price: 144.0,
    extraction_confidence: 0.82,
    verification_level: "market_validated",
    text: "bought 3 MU calls 150 09/18 premium 7.50",
    minutesAgo: 35,
    leg: { strike: 150, expiration_date: "2026-09-18", contracts: 3, premium: 7.5, dte: 61, moneyness: "OTM", delta: 0.44, implied_volatility: 0.58 },
  },
  {
    id: "10000000-0000-0000-0000-000000000004",
    reddit_post_id: "dev_post_nvda_001",
    author_hash: "dev_author_004",
    ticker: "NVDA",
    direction: "bullish",
    option_type: "call",
    status: "open",
    declared_capital: 1620,
    verified_capital: 1620,
    notional_exposure: 40000,
    max_loss: 1620,
    breakeven: 208.1,
    entry_underlying_price: 195.0,
    extraction_confidence: 0.8,
    verification_level: "internally_consistent",
    text: "bought 2 NVDA calls 200 8/21 @ 8.10",
    minutesAgo: 25,
    leg: { strike: 200, expiration_date: "2026-08-21", contracts: 2, premium: 8.1, dte: 33, moneyness: "OTM", delta: 0.45, implied_volatility: 0.55 },
  },
  {
    id: "10000000-0000-0000-0000-000000000005",
    reddit_post_id: "dev_post_gme_001",
    author_hash: "dev_author_005",
    ticker: "GME",
    direction: "bullish",
    option_type: "call",
    status: "open",
    declared_capital: 1900,
    verified_capital: 0,
    notional_exposure: 70000,
    max_loss: 1900,
    breakeven: 35.95,
    entry_underlying_price: 31.4,
    extraction_confidence: 0.77,
    verification_level: "screenshot_detected",
    text: "GME calls 35 07/31 20 contracts paid 0.95",
    minutesAgo: 20,
    leg: { strike: 35, expiration_date: "2026-07-31", contracts: 20, premium: 0.95, dte: 12, moneyness: "OTM", delta: 0.3, implied_volatility: 0.9 },
  },
];

/** Bucket "now" to the minute so repeated reads produce stable timestamps. */
function bucketedNow(): number {
  const MINUTE = 60 * 1000;
  return Math.floor(Date.now() / MINUTE) * MINUTE;
}

function toBet(spec: DemoBetSpec, now: number): Bet {
  const createdAt = new Date(now - spec.minutesAgo * 60 * 1000).toISOString();
  const entryAt = new Date(now - (spec.minutesAgo + 5) * 60 * 1000).toISOString();
  return {
    id: spec.id,
    source_type: "reddit",
    reddit_post_id: spec.reddit_post_id,
    reddit_comment_id: null,
    author_hash: spec.author_hash,
    ticker: spec.ticker,
    direction: spec.direction,
    instrument: "option",
    option_type: spec.option_type,
    position_intent: "real_position",
    status: spec.status,
    declared_capital: spec.declared_capital,
    verified_capital: spec.verified_capital,
    notional_exposure: spec.notional_exposure,
    max_loss: spec.max_loss,
    max_gain: null,
    breakeven: spec.breakeven,
    entry_underlying_price: spec.entry_underlying_price,
    entry_timestamp: entryAt,
    extraction_confidence: spec.extraction_confidence,
    verification_level: spec.verification_level,
    raw_evidence: { text: spec.text },
    // Not part of the Bet interface but present in the DB payload; the frontend
    // reads `metadata.demo` to render a "Demo data" badge.
    metadata: { demo: true },
    created_at: createdAt,
    updated_at: createdAt,
  } as Bet & { metadata: { demo: true } };
}

/** All demo bets, newest first, with fresh (recent) timestamps. */
export function demoBets(): Bet[] {
  const now = bucketedNow();
  return SPECS.map((s) => toBet(s, now)).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/** Demo bets filtered the same way the SQL feed would filter them. */
export function filterDemoBets(filters: BetFilters = {}): Bet[] {
  let rows = demoBets();
  if (filters.ticker) rows = rows.filter((b) => b.ticker === filters.ticker!.toUpperCase());
  if (filters.optionType) rows = rows.filter((b) => b.option_type === filters.optionType);
  if (filters.verificationLevel)
    rows = rows.filter((b) => b.verification_level === filters.verificationLevel);
  if (filters.status) rows = rows.filter((b) => b.status === filters.status);
  if (filters.positionIntent)
    rows = rows.filter((b) => b.position_intent === filters.positionIntent);
  if (typeof filters.minDeclaredCapital === "number")
    rows = rows.filter((b) => (b.declared_capital ?? 0) >= filters.minDeclaredCapital!);
  return rows.slice(0, filters.limit ?? 100);
}

/** A single demo bet by id, or null when it isn't one of the demo positions. */
export function demoBetById(id: string): Bet | null {
  const spec = SPECS.find((s) => s.id === id);
  return spec ? toBet(spec, bucketedNow()) : null;
}

/** Demo legs for a demo bet, or [] when the id isn't a demo position. */
export function demoLegsForBet(betId: string): BetLeg[] {
  const spec = SPECS.find((s) => s.id === betId);
  if (!spec) return [];
  const now = bucketedNow();
  return [
    {
      id: `${spec.id}-leg-1`,
      bet_id: spec.id,
      leg_type: "option",
      side: "long",
      option_type: spec.option_type,
      strike: spec.leg.strike,
      expiration_date: spec.leg.expiration_date,
      contracts: spec.leg.contracts,
      shares: null,
      premium: spec.leg.premium,
      price: spec.leg.premium,
      dte: spec.leg.dte,
      moneyness: spec.leg.moneyness,
      delta: spec.leg.delta,
      theta: null,
      vega: null,
      implied_volatility: spec.leg.implied_volatility,
      bid: null,
      ask: null,
      mid: spec.leg.premium,
      created_at: new Date(now).toISOString(),
    },
  ];
}
