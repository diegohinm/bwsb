/**
 * prisma/seed.ts — the ONE canonical seed for bwsb (YOLOPulse / wsb).
 *
 * Run with `npm run db:seed` (→ `prisma db seed`). Replaces the old
 * src/scripts/seedDatabase.ts, which spoke raw SQL through pg.Client.
 *
 * Three tiers, in this order:
 *
 *   1. REFERENCE DATA   the ticker catalog. Always seeded, everywhere.
 *   2. DEFAULT CONFIG   the default paper-trading season. Always seeded.
 *   3. DEMO DATA        fake users, bets, portfolios, social posts and mock
 *                       market data. ONLY when SEED_DEMO_DATA=true and
 *                       NODE_ENV is not production (see config/env.ts).
 *
 * Guarantees:
 *   - Idempotent. Every write is an upsert on a stable key, or a delete scoped
 *     to rows this seed owns followed by an insert. Running it twice changes no
 *     row counts.
 *   - Never destructive to real data. It does not truncate, never deletes real
 *     users, bets, sessions, tokens, worker_runs or provider snapshots, and
 *     never overwrites a real account's email, password, avatar or verified
 *     status.
 *   - Offline. No Mindcase, Databento, Reddit or Google calls — every value is
 *     a local constant.
 *   - Quiet. Nothing secret is ever logged.
 */
import "dotenv/config";

import { Prisma } from "@prisma/client";

import { prisma, disconnectPrisma } from "../src/lib/prisma.js";
import { demoSeedAllowed, env, isProduction } from "../src/config/env.js";
import { DEFAULT_AVATAR_URL, DEFAULT_AVATAR_TYPE } from "../src/config/branding.js";

/**
 * Marker written into every `metadata`/`evidence` JSON column this seed owns.
 * Demo cleanup deletes ONLY rows carrying it, so a row written by the worker or
 * by a real user is never in scope.
 */
const SEED_KEY = "yolopulse-dev-seed";
const SEED_MARK = { seeded: true, seedKey: SEED_KEY } as const;

/** Provenance stamped on every demo row, so no reader can mistake it for real. */
const DEMO_PROVIDER = "mock";
const DEMO_SOURCE = "seed";
const DEMO_DISPLAY_MODE = "mock";

/** Stable ids so child rows can reference their parents across runs. */
const DEMO_COMPETITION_SLUG = "yolo-arena-season-04";
const LEGACY_COMPETITION_ID = "40000000-0000-0000-0000-000000000001";
const DEMO_OWNER_ID = "00000000-0000-0000-0000-000000000001";
const DEMO_WATCHLIST_ID = "30000000-0000-0000-0000-000000000001";

const BET_IDS = {
  RDDT: "10000000-0000-0000-0000-000000000001",
  POET: "10000000-0000-0000-0000-000000000002",
  MU: "10000000-0000-0000-0000-000000000003",
  NVDA: "10000000-0000-0000-0000-000000000004",
  GME: "10000000-0000-0000-0000-000000000005",
};
const ALL_BET_IDS = Object.values(BET_IDS);

// ── Time helpers (UTC — the database's timezone) ─────────────────────────────

const NOW = new Date();
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * MINUTE_MS);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

/** date_trunc('minute'|'hour'|'day', now()) */
function truncate(unit: "minute" | "hour" | "day"): Date {
  const d = new Date(NOW.getTime());
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  if (unit === "minute") return d;
  d.setUTCMinutes(0);
  if (unit === "hour") return d;
  d.setUTCHours(0);
  return d;
}

const MINUTE_BUCKET = truncate("minute");
const HOUR_BUCKET = truncate("hour");
const DAY_BUCKET = truncate("day");
const TODAY = truncate("day");

/** A literal `date` value, anchored at UTC midnight. */
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const log = (msg: string) => console.log(`  • ${msg}`);

// ═════════════════════════════════════════════════════════════════════════════
// 1. REFERENCE DATA — always seeded
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The default ticker catalog: [symbol, company, exchange, isCommonWord].
 *
 * `isCommonWord` marks symbols that are also ordinary English words (AI, ON,
 * NOW, TEAM); the mention extractor needs it to avoid tagging every "now" in a
 * post as a ticker.
 */
const REFERENCE_TICKERS: ReadonlyArray<
  readonly [string, string, string, boolean]
> = [
  ["RDDT", "Reddit, Inc.", "NYSE", false],
  ["POET", "POET Technologies Inc.", "NASDAQ", false],
  ["MU", "Micron Technology, Inc.", "NASDAQ", false],
  ["NVDA", "NVIDIA Corporation", "NASDAQ", false],
  ["TSLA", "Tesla, Inc.", "NASDAQ", false],
  ["GME", "GameStop Corp.", "NYSE", false],
  ["AMC", "AMC Entertainment Holdings", "NYSE", false],
  ["PLTR", "Palantir Technologies Inc.", "NASDAQ", false],
  ["HOOD", "Robinhood Markets, Inc.", "NASDAQ", false],
  ["SOFI", "SoFi Technologies, Inc.", "NASDAQ", false],
  ["AI", "C3.ai, Inc.", "NYSE", true],
  ["ON", "ON Semiconductor Corp.", "NASDAQ", true],
  ["MSFT", "Microsoft Corporation", "NASDAQ", false],
  ["AAPL", "Apple Inc.", "NASDAQ", false],
  ["META", "Meta Platforms, Inc.", "NASDAQ", false],
  ["GOOG", "Alphabet Inc.", "NASDAQ", false],
  ["GOOGL", "Alphabet Inc.", "NASDAQ", false],
  ["AMZN", "Amazon.com, Inc.", "NASDAQ", false],
  ["NFLX", "Netflix, Inc.", "NASDAQ", false],
  ["CRM", "Salesforce, Inc.", "NYSE", false],
  ["NOW", "ServiceNow, Inc.", "NYSE", true],
  ["TEAM", "Atlassian Corporation", "NASDAQ", true],
  // Present in src/config/tickerCatalog.ts (the search fallback) but missing
  // from the previous seed, so the DB and the catalog disagreed.
  ["AMD", "Advanced Micro Devices, Inc.", "NASDAQ", false],
  ["INTC", "Intel Corporation", "NASDAQ", false],
  ["COIN", "Coinbase Global, Inc.", "NASDAQ", false],
  ["SPY", "SPDR S&P 500 ETF Trust", "NYSEARCA", false],
  ["QQQ", "Invesco QQQ Trust", "NASDAQ", false],
];

async function seedReferenceTickers(): Promise<void> {
  for (const [ticker, companyName, exchange, isCommonWord] of REFERENCE_TICKERS) {
    const values = { companyName, exchange, isActive: true, isCommonWord };
    await prisma.tickers.upsert({
      where: { ticker },
      create: { ticker, ...values },
      update: values,
    });
  }
  log(`tickers de referencia: ${REFERENCE_TICKERS.length}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. DEFAULT CONFIGURATION — always seeded
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The default paper-trading season. Upserted on `slug`, so a re-run updates the
 * existing season instead of creating a second one.
 *
 * `startsAt`/`endsAt` are set ONLY on create: they are relative to the moment
 * the season was opened, and recomputing them on every run would silently move
 * the window of a live season. The name is likewise left alone on update — it
 * is user-visible and may have been changed deliberately.
 *
 * No participants are created here. Real users join at runtime; demo
 * participants belong to the demo tier.
 */
async function seedDefaultCompetition(): Promise<void> {
  await prisma.competitions.upsert({
    where: { slug: DEMO_COMPETITION_SLUG },
    create: {
      id: LEGACY_COMPETITION_ID,
      slug: DEMO_COMPETITION_SLUG,
      name: "YOLOPulse Paper Trading League",
      description:
        "Virtual trading only. No real money. Compete on paper-trading returns against other YOLOPulse users.",
      startingCash: 100000,
      isActive: true,
      startsAt: daysAgo(7),
      endsAt: daysAhead(30),
    },
    update: {
      description:
        "Virtual trading only. No real money. Compete on paper-trading returns against other YOLOPulse users.",
      startingCash: 100000,
      isActive: true,
    },
  });
  log(`competicion por defecto: ${DEMO_COMPETITION_SLUG}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. DEMO DATA — only when demoSeedAllowed
// ═════════════════════════════════════════════════════════════════════════════

// ── 3a. Demo users, accounts and participants ────────────────────────────────

/**
 * Fake accounts on the reserved `.yolopulse.local` domain, which can never
 * collide with a real address. Fixed uuids so their virtual accounts, bets and
 * leaderboard rows stay stable across runs.
 *
 * They have NO password hash: they exist to populate the arena and the
 * leaderboard, not to be logged into. Nothing here stores a plaintext password.
 */
const DEMO_USERS = [
  { id: "50000000-0000-0000-0000-000000000001", handle: "big-green-candle", displayName: "Big Green Candle", equity: 138_420.55 },
  { id: "50000000-0000-0000-0000-000000000002", handle: "theta-bandit", displayName: "Theta Bandit", equity: 112_980.10 },
  { id: "50000000-0000-0000-0000-000000000003", handle: "diamond-hands", displayName: "Diamond Hands", equity: 96_500.00 },
  { id: "50000000-0000-0000-0000-000000000004", handle: "sir-yolo-lot", displayName: "Sir Yolo-a-Lot", equity: 61_235.75 },
] as const;

const demoEmail = (handle: string) => `demo-${handle}@yolopulse.local`;

async function seedDemoUsers(): Promise<void> {
  const competition = await prisma.competitions.findUnique({
    where: { slug: DEMO_COMPETITION_SLUG },
    select: { id: true },
  });

  for (const user of DEMO_USERS) {
    const email = demoEmail(user.handle);

    // One transaction per user: an account without its virtual portfolio would
    // show up in the arena with no balance.
    await prisma.$transaction(async (tx) => {
      // `update: {}` is the whole point — if an account with this email already
      // exists it is left EXACTLY as it is. No email, password hash, Google
      // link, avatar or verified status is ever touched by the seed.
      const account = await tx.appUsers.upsert({
        where: { emailNormalized: email },
        create: {
          id: user.id,
          email,
          emailNormalized: email,
          displayName: user.displayName,
          emailVerifiedAt: NOW,
          passwordHash: null,
          avatarUrl: DEFAULT_AVATAR_URL,
          avatarType: DEFAULT_AVATAR_TYPE,
          authProvider: "seed",
        },
        update: {},
        select: { id: true },
      });

      // Balances are set on create only: a demo account that has been paper
      // traded against in development keeps whatever it holds now.
      await tx.virtualAccounts.upsert({
        where: { userId: account.id },
        create: {
          userId: account.id,
          startingCash: 100000,
          cashBalance: user.equity,
          equityValue: user.equity,
        },
        update: {},
      });

      if (competition) {
        const virtualAccount = await tx.virtualAccounts.findUnique({
          where: { userId: account.id },
          select: { id: true },
        });

        await tx.competitionParticipants.upsert({
          where: {
            competitionId_userId: {
              competitionId: competition.id,
              userId: account.id,
            },
          },
          create: {
            competitionId: competition.id,
            userId: account.id,
            virtualAccountId: virtualAccount?.id ?? null,
          },
          update: {},
        });
      }
    });
  }

  log(`usuarios demo: ${DEMO_USERS.length} (sin contrasena, no permiten login)`);
}

/**
 * A ranked leaderboard snapshot for the demo participants.
 *
 * competition_leaderboard_snapshots is append-only with no unique key, so the
 * previous seed-owned rows are removed first — scoped to the demo competition
 * AND the demo user ids, so a real participant's history is never touched.
 */
async function seedDemoLeaderboard(): Promise<void> {
  const competition = await prisma.competitions.findUnique({
    where: { slug: DEMO_COMPETITION_SLUG },
    select: { id: true, startingCash: true },
  });
  if (!competition) return;

  const demoIds = DEMO_USERS.map((u) => u.id);
  const startingCash = competition.startingCash
    ? competition.startingCash.toNumber()
    : 100000;

  const ranked = [...DEMO_USERS]
    .sort((a, b) => b.equity - a.equity)
    .map((u, i) => ({
      competitionId: competition.id,
      userId: u.id,
      rank: i + 1,
      equityValue: u.equity,
      returnPct: Math.round(((u.equity - startingCash) / startingCash) * 100 * 100) / 100,
      snapshotAt: NOW,
    }));

  await prisma.$transaction([
    prisma.competitionLeaderboardSnapshots.deleteMany({
      where: { competitionId: competition.id, userId: { in: demoIds } },
    }),
    prisma.competitionLeaderboardSnapshots.createMany({ data: ranked }),
  ]);

  log(`snapshot de leaderboard demo: ${ranked.length} filas`);
}

// ── 3b. Demo social content ──────────────────────────────────────────────────

const POSTS = [
  {
    redditPostId: "dev_post_rddt_001",
    subreddit: "wallstreetbets",
    title: "RDDT calls before earnings?",
    bodyExcerpt:
      "Bought 5 RDDT calls strike 180 exp Aug 21 premium 4.20. Mentions picking up. Numbers: rev +21%, guidance raised, source: 10-Q. Risk: crowded.",
    authorHash: "dev_author_001",
    score: 128,
    numComments: 44,
    redditCreatedAt: minutesAgo(55),
  },
  {
    redditPostId: "dev_post_poet_001",
    subreddit: "wallstreetbets",
    title: "POET squeeze incoming or another trap?",
    bodyExcerpt:
      "POET to the moon!!! easy 10x, everyone buy now, this is the play, loading puts 7.5p 8/21 paid 1.20. guaranteed.",
    authorHash: "dev_author_002",
    score: 242,
    numComments: 91,
    redditCreatedAt: minutesAgo(45),
  },
  {
    redditPostId: "dev_post_mu_001",
    subreddit: "stocks",
    title: "MU memory cycle is heating up",
    bodyExcerpt:
      "Micron HBM narrative. Bought 3 MU calls 150 09/18 premium 7.50. DCF suggests upside, catalyst: earnings, risk disclosed.",
    authorHash: "dev_author_003",
    score: 96,
    numComments: 32,
    redditCreatedAt: minutesAgo(35),
  },
  {
    redditPostId: "dev_post_nvda_001",
    subreddit: "wallstreetbets",
    title: "NVDA still the king or too crowded?",
    bodyExcerpt:
      "NVDA mentioned again, might be crowded. bought 2 NVDA calls 200 8/21 @ 8.10. still holding my position.",
    authorHash: "dev_author_004",
    score: 310,
    numComments: 140,
    redditCreatedAt: minutesAgo(25),
  },
  {
    redditPostId: "dev_post_gme_001",
    subreddit: "wallstreetbets",
    title: "GME nostalgia is back",
    bodyExcerpt:
      "GME calls 35 07/31 20 contracts paid 0.95. diamond hands, yolo, still holding down 40% but averaging down.",
    authorHash: "dev_author_005",
    score: 190,
    numComments: 77,
    redditCreatedAt: minutesAgo(20),
  },
  {
    redditPostId: "dev_post_tsla_001",
    subreddit: "wallstreetbets",
    title: "TSLA thinking about calls",
    bodyExcerpt:
      "thinking about TSLA calls, might buy next week, watching for now. should I?",
    authorHash: "dev_author_006",
    score: 75,
    numComments: 29,
    redditCreatedAt: minutesAgo(15),
  },
  {
    redditPostId: "dev_post_amc_001",
    subreddit: "wallstreetbets",
    title: "AMC bagholders check in",
    bodyExcerpt:
      "AMC still holding since 2021, down 90%, cant sell now, this is fine. capitulation everywhere.",
    authorHash: "dev_author_002",
    score: 54,
    numComments: 61,
    redditCreatedAt: minutesAgo(10),
  },
].map((p) => ({
  ...p,
  permalink: `https://reddit.com/r/${p.subreddit}/comments/${p.redditPostId}`,
}));

const COMMENTS = [
  ["dev_cmt_rddt_1", "dev_post_rddt_001", "wallstreetbets", "dev_author_010", "calls printing, in since 150", 34, 50],
  ["dev_cmt_poet_1", "dev_post_poet_001", "wallstreetbets", "dev_author_011", "this smells like a pump, be careful", 88, 40],
  ["dev_cmt_poet_2", "dev_post_poet_001", "wallstreetbets", "dev_author_012", "buy buy buy 10x incoming", 5, 39],
  ["dev_cmt_nvda_1", "dev_post_nvda_001", "wallstreetbets", "dev_author_013", "too crowded, taking profits", 51, 20],
  ["dev_cmt_gme_1", "dev_post_gme_001", "wallstreetbets", "dev_author_014", "diamond hands never selling", 40, 18],
] as const;

const MENTIONS = [
  ["RDDT", "dev_post_rddt_001", 0.2, "early_narrative"],
  ["POET", "dev_post_poet_001", 0.85, "pump_risk"],
  ["MU", "dev_post_mu_001", 0.15, "momentum_confirmation"],
  ["NVDA", "dev_post_nvda_001", 0.5, "late_crowded_trade"],
  ["GME", "dev_post_gme_001", 0.75, "meme_revival"],
  ["TSLA", "dev_post_tsla_001", 0.3, "speculation"],
  ["AMC", "dev_post_amc_001", 0.4, "bagholder"],
] as const;

const STANCE_EVENTS = [
  ["RDDT", "dev_post_rddt_001", "dev_author_001", "wallstreetbets", "bullish", 0.8, ["calls", "bought"]],
  ["POET", "dev_post_poet_001", "dev_author_002", "wallstreetbets", "bearish", 0.65, ["puts", "loading"]],
  ["MU", "dev_post_mu_001", "dev_author_003", "stocks", "bullish", 0.72, ["calls", "upside"]],
  ["NVDA", "dev_post_nvda_001", "dev_author_004", "wallstreetbets", "bullish", 0.55, ["calls", "holding"]],
  ["GME", "dev_post_gme_001", "dev_author_005", "wallstreetbets", "bullish", 0.6, ["calls", "diamond hands"]],
  ["TSLA", "dev_post_tsla_001", "dev_author_006", "wallstreetbets", "neutral", 0.4, ["thinking", "watching"]],
  ["AMC", "dev_post_amc_001", "dev_author_002", "wallstreetbets", "bearish", 0.5, ["down", "cant sell"]],
] as const;

/** Normalized social feed rows, mirroring what the worker would ingest. */
const SOCIAL_POSTS = [
  ["seed-wsb-rddt-001", "wallstreetbets", "RDDT calls before earnings?", ["RDDT"], "bullish", 0.8, 128, 44, 55],
  ["seed-wsb-poet-001", "wallstreetbets", "POET squeeze incoming or another trap?", ["POET"], "bearish", 0.65, 242, 91, 45],
  ["seed-stocks-mu-001", "stocks", "MU memory cycle is heating up", ["MU"], "bullish", 0.72, 96, 32, 35],
  ["seed-wsb-nvda-001", "wallstreetbets", "NVDA still the king or too crowded?", ["NVDA"], "bullish", 0.55, 310, 140, 25],
  ["seed-wsb-gme-001", "wallstreetbets", "GME nostalgia is back", ["GME"], "bullish", 0.6, 190, 77, 20],
] as const;

const SOCIAL_COMMENTS = [
  ["seed-cmt-rddt-001", "seed-wsb-rddt-001", "wallstreetbets", "calls printing, in since 150", ["RDDT"], "bullish", 0.7, 34, 50],
  ["seed-cmt-poet-001", "seed-wsb-poet-001", "wallstreetbets", "this smells like a pump, be careful", ["POET"], "bearish", 0.75, 88, 40],
  ["seed-cmt-nvda-001", "seed-wsb-nvda-001", "wallstreetbets", "too crowded, taking profits", ["NVDA"], "bearish", 0.6, 51, 20],
] as const;

async function seedDemoSocial(): Promise<void> {
  for (const post of POSTS) {
    const { redditPostId, ...values } = post;
    await prisma.redditPosts.upsert({
      where: { redditPostId },
      create: { redditPostId, ...values },
      update: values,
    });
  }

  for (const [id, postId, subreddit, authorHash, body, score, minutes] of COMMENTS) {
    await prisma.redditComments.upsert({
      where: { redditCommentId: id },
      create: {
        redditCommentId: id,
        redditPostId: postId,
        subreddit,
        authorHash,
        bodyExcerpt: body,
        score,
        redditCreatedAt: minutesAgo(minutes),
      },
      update: { bodyExcerpt: body, score },
    });
  }

  // Upsert on the (ticker, reddit_post_id) unique key — no delete needed.
  for (const [ticker, redditPostId, pumpLanguageScore, narrativeType] of MENTIONS) {
    await prisma.tickerMentions.upsert({
      where: { ticker_redditPostId: { ticker, redditPostId } },
      create: { ticker, redditPostId, pumpLanguageScore, narrativeType },
      update: { pumpLanguageScore, narrativeType },
    });
  }

  // ticker_stance_events has no unique key, so seed-owned rows are replaced.
  // Scoped to the dev_post_ prefix this seed created: real stance events
  // extracted from genuine posts are never in scope.
  await prisma.$transaction([
    prisma.tickerStanceEvents.deleteMany({
      where: { redditPostId: { startsWith: "dev_post_" } },
    }),
    prisma.tickerStanceEvents.createMany({
      data: STANCE_EVENTS.map(
        ([ticker, redditPostId, authorHash, subreddit, stance, confidence, matchedTerms]) => ({
          ticker,
          redditPostId,
          authorHash,
          subreddit,
          stance,
          confidence,
          matchedTerms: [...matchedTerms],
        }),
      ),
    }),
  ]);

  // Normalized feed. provider=mock / source=seed / isMock so the API and the UI
  // label it as demo content and never present it as Mindcase data.
  for (const [externalId, subreddit, title, tickers, stance, confidence, score, comments, minutes] of SOCIAL_POSTS) {
    const values = {
      provider: DEMO_PROVIDER,
      source: DEMO_SOURCE,
      subreddit,
      type: "post",
      title,
      body: title,
      url: `https://reddit.com/r/${subreddit}/comments/${externalId}`,
      authorHash: `seed_author_${externalId.slice(-3)}`,
      score,
      commentCount: comments,
      tickers: [...tickers],
      sentiment: stance,
      stance,
      confidence,
      isScreenshot: false,
      postedAt: minutesAgo(minutes),
    };
    await prisma.socialPosts.upsert({
      where: { externalId },
      create: { externalId, ...values },
      update: values,
    });
  }

  for (const [externalId, postExternalId, subreddit, body, tickers, stance, confidence, score, minutes] of SOCIAL_COMMENTS) {
    const values = {
      provider: DEMO_PROVIDER,
      source: DEMO_SOURCE,
      subreddit,
      postExternalId,
      body,
      url: `https://reddit.com/r/${subreddit}/comments/${postExternalId}/${externalId}`,
      authorHash: `seed_author_${externalId.slice(-3)}`,
      score,
      tickers: [...tickers],
      sentiment: stance,
      stance,
      confidence,
      postedAt: minutesAgo(minutes),
    };
    await prisma.socialComments.upsert({
      where: { externalId },
      create: { externalId, ...values },
      update: values,
    });
  }

  log(
    `contenido social demo: ${POSTS.length} posts reddit, ${COMMENTS.length} comentarios, ` +
      `${SOCIAL_POSTS.length} posts normalizados, ${SOCIAL_COMMENTS.length} comentarios normalizados`,
  );
}

// ── 3c. Demo metrics, trends and alerts ──────────────────────────────────────

const METRICS_5M = [
  ["RDDT", 42, 7, 35, 87, 210, 6.2, 8.4, 0.62, 0.25],
  ["POET", 84, 13, 41, 115, 390, 18.5, 26.0, 0.3, 0.86],
  ["MU", 31, 5, 28, 64, 120, 3.8, 4.1, 0.71, 0.18],
  ["NVDA", 66, 11, 54, 143, 480, 7.4, 5.9, 0.58, 0.52],
  ["GME", 58, 9, 33, 132, 310, 9.1, 12.2, 0.64, 0.78],
  ["TSLA", 22, 4, 19, 70, 100, 2.1, 2.4, 0.5, 0.3],
  ["AMC", 18, 3, 12, 48, 90, 1.4, 3.0, 0.35, 0.4],
] as const;

/** ticker, base, slope, bullish %, sentiment — shape of the 14-day back-series. */
const DAILY_SHAPES = [
  ["RDDT", 45, 2, 70, 0.62],
  ["POET", 90, 5, 40, 0.3],
  ["MU", 34, 1, 72, 0.71],
  ["NVDA", 70, 2, 58, 0.58],
  ["GME", 60, 3, 64, 0.64],
  ["TSLA", 25, 1, 50, 0.5],
  ["AMC", 20, 1, 35, 0.35],
] as const;

const TREND_CLASSIFICATIONS = [
  ["POET", "most_mentioned", 84, 1, { mentions_1h: 84 }],
  ["NVDA", "most_mentioned", 66, 2, { mentions_1h: 66 }],
  ["GME", "most_mentioned", 58, 3, { mentions_1h: 58 }],
  ["POET", "acceleration", 18.5, 1, { velocity: 18.5 }],
  ["GME", "acceleration", 9.1, 2, { velocity: 9.1 }],
  ["RDDT", "fresh_breakout", 0.71, 1, { share_7d: 0.71 }],
  ["MU", "bullish_pressure", 0.71, 1, { sentiment: 0.71 }],
  ["RDDT", "bullish_pressure", 0.62, 2, { sentiment: 0.62 }],
  ["POET", "bearish_pressure", 0.3, 1, { sentiment: 0.3 }],
  ["AMC", "bearish_pressure", 0.35, 2, { sentiment: 0.35 }],
  ["NVDA", "disagreement", 0.48, 1, { bull: 0.55, bear: 0.45 }],
  ["POET", "one_sided_attention", 0.88, 1, { one_sided: 0.88 }],
  ["POET", "penny_attention", 0.85, 1, { price: 4.9 }],
  ["AMC", "penny_attention", 0.55, 2, { price: 3.1 }],
] as const;

const ALERTS = [
  ["POET", "possible_coordination", "high", "Repeated promotional phrases and high author concentration on a low-priced ticker.", { repeated_phrases: ["to the moon", "easy 10x", "buy now"], author_concentration: 0.62, new_account_ratio: 0.35, deletion_rate: 0.18 }],
  ["RDDT", "declared_call_capital_spike", "medium", "Declared call premium at risk rose sharply in the last hour.", { declared_call_capital: 21000, window: "1h", delta_pct: 180 }],
  ["POET", "declared_put_capital_spike", "medium", "Declared put premium building against the crowd.", { declared_put_capital: 12000, window: "1h" }],
  ["MU", "verified_bets_cluster", "low", "Multiple internally-consistent bets clustered around the 150 strike.", { cluster_strike: 150, verified_bets: 3 }],
  ["NVDA", "smart_authors_against_crowd", "medium", "Higher-reputation authors are fading a crowded bullish tape.", { smart_authors: 4, crowd_stance: "bullish" }],
  ["GME", "expiration_wall_this_week", "high", "Large contract concentration expiring 07/31.", { expiration: "2026-07-31", contracts: 20 }],
  ["AMC", "bullish_sentiment_negative_collective_pl", "medium", "Conversation stays bullish while collective P/L is deeply negative.", { sentiment: 0.35, collective_pl_pct: -38 }],
] as const;

const AUTHORS = [
  ["dev_author_001", 1450, 320, 41, 0.68, 74.0, false],
  ["dev_author_002", 28, 90, 12, 0.33, 22.0, true],
  ["dev_author_003", 2100, 510, 63, 0.71, 81.0, false],
  ["dev_author_004", 900, 210, 30, 0.57, 55.0, false],
  ["dev_author_005", 1200, 260, 25, 0.6, 58.0, false],
  ["dev_author_006", 40, 15, 3, 0.33, 18.0, true],
] as const;

/**
 * The 14-day mention series the old SQL built with generate_series.
 *
 * PostgreSQL integer division truncates toward zero, so every count that was an
 * integer expression there is truncated here too — otherwise the seeded numbers
 * would drift from what the previous script produced.
 */
function dailyMetricRows() {
  const rows = [];
  for (const [ticker, base, slope, bull, sentiment] of DAILY_SHAPES) {
    for (let g = 0; g <= 13; g += 1) {
      const decayed = base - g * slope;
      rows.push({
        ticker,
        day: new Date(TODAY.getTime() - g * DAY_MS),
        mentions: Math.max(3, decayed + ((g * 7 + ticker.length) % 9)),
        uniqueAuthors: Math.max(2, Math.trunc(decayed / 2)),
        bullish: Math.max(1, Math.trunc((decayed * bull) / 100)),
        bearish: Math.max(1, Math.trunc((decayed * (100 - bull)) / 100)),
        neutral: 2,
        sentimentScore: sentiment,
        mentionShare: Math.min(0.9, Math.max(0.02, decayed / 400)),
      });
    }
  }
  return rows;
}

async function seedDemoMetrics(): Promise<void> {
  for (const [ticker, mentions, postsCount, uniqueAuthors, avgScore, totalComments, mentionVelocity, abnormalityScore, sentimentScore, pumpLanguageScore] of METRICS_5M) {
    const values = { mentions, postsCount, uniqueAuthors, avgScore, totalComments, mentionVelocity, abnormalityScore, sentimentScore, pumpLanguageScore };
    await prisma.tickerMetrics5m.upsert({
      where: { ticker_bucketStart: { ticker, bucketStart: MINUTE_BUCKET } },
      create: { ticker, bucketStart: MINUTE_BUCKET, ...values },
      update: values,
    });
  }

  // Upsert on the (ticker, day) primary key. The previous script deleted every
  // daily-metrics row for these tickers first, which would have destroyed real
  // aggregates computed by the pipeline.
  for (const row of dailyMetricRows()) {
    const { ticker, day, ...values } = row;
    await prisma.tickerDailyMetrics.upsert({
      where: { ticker_day: { ticker, day } },
      create: { ticker, day, ...values },
      update: values,
    });
  }

  // Upsert on (ticker, bucket_start, classification). The previous script
  // deleted EVERY classification from today, seeded or not.
  for (const [ticker, classification, score, rank, evidence] of TREND_CLASSIFICATIONS) {
    const values = { score, rank, evidence: { ...evidence, ...SEED_MARK } };
    await prisma.tickerTrendClassifications.upsert({
      where: {
        ticker_bucketStart_classification: {
          ticker,
          bucketStart: HOUR_BUCKET,
          classification,
        },
      },
      create: { ticker, bucketStart: HOUR_BUCKET, classification, ...values },
      update: values,
    });
  }

  const attention = {
    indexValue: 68.4,
    label: "Elevated Retail Attention",
    components: {
      stance_balance: 0.58,
      breadth: 0.62,
      price_confirmation: 0.55,
      conversation_velocity: 0.74,
      bet_capital_flow: 0.66,
    },
  };
  await prisma.marketAttentionIndexes.upsert({
    where: { scope_bucketStart: { scope: "global", bucketStart: HOUR_BUCKET } },
    create: { scope: "global", bucketStart: HOUR_BUCKET, ...attention },
    update: attention,
  });

  // ticker_alerts has no natural key. Only rows carrying this seed's marker are
  // removed — alerts produced by the alert engine are never in scope.
  await prisma.$transaction([
    prisma.tickerAlerts.deleteMany({
      where: {
        OR: [
          { metricsSnapshot: { path: ["seedKey"], equals: SEED_KEY } },
          // Rows written by the previous script, which marked them {"seed":true}.
          { metricsSnapshot: { path: ["seed"], equals: true } },
        ],
      },
    }),
    prisma.tickerAlerts.createMany({
      data: ALERTS.map(([ticker, alertType, severity, explanation, evidence]) => ({
        ticker,
        alertType,
        severity,
        explanation,
        metricsSnapshot: SEED_MARK,
        evidence,
      })),
    }),
  ]);

  for (const [authorHash, accountAgeDays, postsCount, resolvedSignals, hitRate, reputationScore, isNewAccount] of AUTHORS) {
    const values = { accountAgeDays, postsCount, resolvedSignals, hitRate, reputationScore, isNewAccount };
    await prisma.anonymizedAuthors.upsert({
      where: { authorHash },
      create: { authorHash, ...values },
      update: values,
    });
  }

  await prisma.$transaction([
    prisma.authorSignalHistory.deleteMany({
      where: { authorHash: { startsWith: "dev_author_" } },
    }),
    prisma.authorSignalHistory.createMany({
      data: [
        { authorHash: "dev_author_003", ticker: "MU", signalType: "early_mention", stance: "bullish", signaledAt: daysAgo(9), resolvedAt: daysAgo(2), outcome: "win", returnPct: 22.5, wasEarly: true, metadata: SEED_MARK },
        { authorHash: "dev_author_001", ticker: "RDDT", signalType: "early_mention", stance: "bullish", signaledAt: daysAgo(6), resolvedAt: daysAgo(1), outcome: "win", returnPct: 14.0, wasEarly: true, metadata: SEED_MARK },
        { authorHash: "dev_author_004", ticker: "NVDA", signalType: "crowd_mention", stance: "bullish", signaledAt: daysAgo(5), resolvedAt: daysAgo(1), outcome: "loss", returnPct: -6.0, wasEarly: false, metadata: SEED_MARK },
        { authorHash: "dev_author_002", ticker: "POET", signalType: "pump_mention", stance: "bullish", signaledAt: daysAgo(3), resolvedAt: null, outcome: null, returnPct: null, wasEarly: false, metadata: SEED_MARK },
      ],
    }),
  ]);

  log("metricas, tendencias, alertas y autores demo");
}

// ── 3d. Demo market data ─────────────────────────────────────────────────────

const MARKET_SNAPSHOTS = [
  ["RDDT", 178.4, 2.1, 9200000, 8100000, 30000000000, 1.35],
  ["POET", 4.9, 8.6, 15000000, 6000000, 250000000, 2.4],
  ["MU", 146.2, 1.3, 18000000, 20000000, 160000000000, 1.15],
  ["NVDA", 197.1, -0.8, 41000000, 45000000, 2000000000000, 1.6],
  ["GME", 33.1, 5.4, 12000000, 7000000, 14000000000, 1.8],
  ["TSLA", 312.5, 0.4, 30000000, 32000000, 990000000000, 2.0],
  ["AMC", 3.1, -3.2, 20000000, 10000000, 1500000000, 2.1],
] as const;

const OPTION_CHAINS = [
  { underlying: "RDDT", expiration: date("2026-08-21"), contract: { optionType: "call", strike: 180, bid: 4.1, ask: 4.3, mid: 4.2, last: 4.2, volume: 3200, openInterest: 8100, impliedVolatility: 0.62, delta: 0.48, gamma: 0.02, theta: -0.05, vega: 0.18 } },
  { underlying: "POET", expiration: date("2026-08-21"), contract: { optionType: "put", strike: 7.5, bid: 1.15, ask: 1.25, mid: 1.2, last: 1.2, volume: 900, openInterest: 2400, impliedVolatility: 0.95, delta: -0.42, gamma: 0.03, theta: -0.04, vega: 0.1 } },
  { underlying: "NVDA", expiration: date("2026-08-21"), contract: { optionType: "call", strike: 200, bid: 8.0, ask: 8.2, mid: 8.1, last: 8.1, volume: 5400, openInterest: 12000, impliedVolatility: 0.55, delta: 0.45, gamma: 0.01, theta: -0.07, vega: 0.22 } },
];

/** Deterministic quotes so UI snapshots stay stable between runs. */
const DEMO_QUOTES = [
  ["RDDT", 178.4, 3.67, 2.1, 9200000],
  ["POET", 4.9, 0.39, 8.6, 15000000],
  ["MU", 146.2, 1.88, 1.3, 18000000],
  ["NVDA", 197.1, -1.59, -0.8, 41000000],
  ["GME", 33.1, 1.7, 5.4, 12000000],
  ["TSLA", 312.5, 1.25, 0.4, 30000000],
  ["AMC", 3.1, -0.1, -3.2, 20000000],
] as const;

/**
 * Seed `market_quotes_latest` WITHOUT ever clobbering a real quote.
 *
 * This table is owned by the ingestion worker. A row is only written when it
 * does not exist yet, or when the row already there is itself mock — a genuine
 * Databento quote is left untouched, whatever the seed says.
 */
async function seedDemoQuotes(): Promise<number> {
  let written = 0;

  for (const [symbol, price, change, changePct, volume] of DEMO_QUOTES) {
    const existing = await prisma.marketQuotesLatest.findUnique({
      where: { symbol },
      select: { isMock: true },
    });
    if (existing && !existing.isMock) continue; // real provider data — leave it

    const values = {
      price,
      change,
      changePct,
      volume,
      session: "closed",
      provider: DEMO_PROVIDER,
      source: DEMO_SOURCE,
      displayMode: DEMO_DISPLAY_MODE,
      delayMinutes: null,
      isMock: true,
      isDelayed: false,
      observedAt: DAY_BUCKET,
      updatedAt: NOW,
    };

    await prisma.marketQuotesLatest.upsert({
      where: { symbol },
      create: { symbol, ...values },
      update: values,
    });
    written += 1;
  }

  return written;
}

async function seedDemoMarketData(): Promise<void> {
  for (const [ticker, price, changePct, volume, avgVolume, marketCap, beta] of MARKET_SNAPSHOTS) {
    const values = { price, changePct, volume, avgVolume, marketCap, beta };
    await prisma.marketSnapshots.upsert({
      where: { ticker_snapshotAt: { ticker, snapshotAt: DAY_BUCKET } },
      create: { ticker, snapshotAt: DAY_BUCKET, source: DEMO_SOURCE, metadata: SEED_MARK, ...values },
      update: values,
    });
  }

  // Every delete below is scoped to a seed-owned source ('stub' was the previous
  // script's marker, 'seed' is this one's). Rows written by a real provider
  // carry neither and are never removed.
  const demoSources = { source: { in: ["stub", DEMO_SOURCE] } };

  await prisma.optionChainSnapshots.deleteMany({ where: demoSources });
  for (const chain of OPTION_CHAINS) {
    await prisma.optionChainSnapshots.create({
      data: {
        underlying: chain.underlying,
        snapshotAt: DAY_BUCKET,
        expirationDate: chain.expiration,
        source: DEMO_SOURCE,
        metadata: SEED_MARK,
        optionContractSnapshots: {
          create: {
            underlying: chain.underlying,
            expirationDate: chain.expiration,
            snapshotAt: DAY_BUCKET,
            ...chain.contract,
          },
        },
      },
    });
  }

  await prisma.$transaction([
    prisma.shortInterestSnapshots.deleteMany({ where: demoSources }),
    prisma.shortInterestSnapshots.createMany({
      data: [
        { ticker: "GME", snapshotAt: DAY_BUCKET, shortInterest: 45000000, shortPercentFloat: 0.22, daysToCover: 3.1, borrowFee: 0.08, squeezeRiskScore: 72, source: DEMO_SOURCE, metadata: SEED_MARK },
        { ticker: "AMC", snapshotAt: DAY_BUCKET, shortInterest: 60000000, shortPercentFloat: 0.18, daysToCover: 2.4, borrowFee: 0.15, squeezeRiskScore: 61, source: DEMO_SOURCE, metadata: SEED_MARK },
        { ticker: "POET", snapshotAt: DAY_BUCKET, shortInterest: 12000000, shortPercentFloat: 0.28, daysToCover: 4.0, borrowFee: 0.22, squeezeRiskScore: 66, source: DEMO_SOURCE, metadata: SEED_MARK },
      ],
    }),
  ]);

  await prisma.$transaction([
    prisma.newsEvents.deleteMany({ where: demoSources }),
    prisma.newsEvents.createMany({
      data: [
        { ticker: "RDDT", headline: "Reddit beats revenue estimates, raises guidance", url: "https://example.com/rddt", source: DEMO_SOURCE, sentiment: 0.6, publishedAt: daysAgo(2), metadata: SEED_MARK },
        { ticker: "NVDA", headline: "Analysts debate whether NVDA rally is overextended", url: "https://example.com/nvda", source: DEMO_SOURCE, sentiment: -0.1, publishedAt: daysAgo(1), metadata: SEED_MARK },
        { ticker: "MU", headline: "Memory pricing firms up on HBM demand", url: "https://example.com/mu", source: DEMO_SOURCE, sentiment: 0.5, publishedAt: daysAgo(3), metadata: SEED_MARK },
      ],
    }),
  ]);

  await prisma.$transaction([
    prisma.insiderActivityEvents.deleteMany({ where: demoSources }),
    prisma.insiderActivityEvents.createMany({
      data: [
        { ticker: "RDDT", insiderRole: "CFO", transactionType: "sell", shares: 25000, value: 4400000, filedAt: daysAgo(4), source: DEMO_SOURCE, metadata: SEED_MARK },
        { ticker: "MU", insiderRole: "Director", transactionType: "buy", shares: 10000, value: 1460000, filedAt: daysAgo(6), source: DEMO_SOURCE, metadata: SEED_MARK },
      ],
    }),
  ]);

  await prisma.$transaction([
    prisma.externalSocialSnapshots.deleteMany({
      where: { platform: { in: ["stub", DEMO_SOURCE] } },
    }),
    prisma.externalSocialSnapshots.createMany({
      data: [
        { ticker: "RDDT", platform: DEMO_SOURCE, snapshotAt: DAY_BUCKET, mentions: 1200, sentiment: 0.55, metadata: SEED_MARK },
        { ticker: "POET", platform: DEMO_SOURCE, snapshotAt: DAY_BUCKET, mentions: 3400, sentiment: 0.2, metadata: SEED_MARK },
        { ticker: "GME", platform: DEMO_SOURCE, snapshotAt: DAY_BUCKET, mentions: 2100, sentiment: 0.6, metadata: SEED_MARK },
      ],
    }),
  ]);

  await prisma.$transaction([
    prisma.catalystEvents.deleteMany({
      where: {
        OR: [
          { metadata: { path: ["seedKey"], equals: SEED_KEY } },
          { metadata: { path: ["seed"], equals: true } },
        ],
      },
    }),
    prisma.catalystEvents.createMany({
      data: [
        { ticker: "RDDT", catalystType: "earnings", title: "RDDT Q2 earnings", eventDate: date("2026-08-05"), confirmed: true, metadata: SEED_MARK },
        { ticker: "MU", catalystType: "earnings", title: "MU fiscal Q4 earnings", eventDate: date("2026-09-25"), confirmed: true, metadata: SEED_MARK },
        { ticker: "NVDA", catalystType: "product", title: "NVDA GTC keynote", eventDate: date("2026-08-18"), confirmed: false, metadata: SEED_MARK },
      ],
    }),
  ]);

  const quotes = await seedDemoQuotes();
  log(`datos de mercado demo (mock) — ${quotes}/${DEMO_QUOTES.length} quotes escritas`);
}

// ── 3e. Demo bets ────────────────────────────────────────────────────────────

const BETS = [
  { id: BET_IDS.RDDT, redditPostId: "dev_post_rddt_001", authorHash: "dev_author_001", ticker: "RDDT", direction: "bullish", optionType: "call", declaredCapital: 2100, verifiedCapital: 2100, notionalExposure: 90000, maxLoss: 2100, breakeven: 184.2, entryUnderlyingPrice: 176.0, entryTimestamp: minutesAgo(55), extractionConfidence: 0.86, verificationLevel: "internally_consistent", rawEvidence: { text: "bought 5 RDDT calls strike 180 exp Aug 21 premium 4.20" } },
  { id: BET_IDS.POET, redditPostId: "dev_post_poet_001", authorHash: "dev_author_002", ticker: "POET", direction: "bearish", optionType: "put", declaredCapital: 1200, verifiedCapital: 0, notionalExposure: 7500, maxLoss: 1200, breakeven: 6.3, entryUnderlyingPrice: 5.1, entryTimestamp: minutesAgo(45), extractionConfidence: 0.74, verificationLevel: "text_only", rawEvidence: { text: "loading puts 7.5p 8/21 paid 1.20" } },
  { id: BET_IDS.MU, redditPostId: "dev_post_mu_001", authorHash: "dev_author_003", ticker: "MU", direction: "bullish", optionType: "call", declaredCapital: 2250, verifiedCapital: 2250, notionalExposure: 45000, maxLoss: 2250, breakeven: 157.5, entryUnderlyingPrice: 144.0, entryTimestamp: minutesAgo(35), extractionConfidence: 0.82, verificationLevel: "market_validated", rawEvidence: { text: "bought 3 MU calls 150 09/18 premium 7.50" } },
  { id: BET_IDS.NVDA, redditPostId: "dev_post_nvda_001", authorHash: "dev_author_004", ticker: "NVDA", direction: "bullish", optionType: "call", declaredCapital: 1620, verifiedCapital: 1620, notionalExposure: 40000, maxLoss: 1620, breakeven: 208.1, entryUnderlyingPrice: 195.0, entryTimestamp: minutesAgo(25), extractionConfidence: 0.8, verificationLevel: "internally_consistent", rawEvidence: { text: "bought 2 NVDA calls 200 8/21 @ 8.10" } },
  { id: BET_IDS.GME, redditPostId: "dev_post_gme_001", authorHash: "dev_author_005", ticker: "GME", direction: "bullish", optionType: "call", declaredCapital: 1900, verifiedCapital: 0, notionalExposure: 70000, maxLoss: 1900, breakeven: 35.95, entryUnderlyingPrice: 31.4, entryTimestamp: minutesAgo(20), extractionConfidence: 0.77, verificationLevel: "screenshot_detected", rawEvidence: { text: "GME calls 35 07/31 20 contracts paid 0.95" } },
];

const BET_LEGS = [
  [BET_IDS.RDDT, "call", 180, "2026-08-21", 5, 4.2, 33, "OTM", 0.48, 0.62, 4.1, 4.3, 4.2],
  [BET_IDS.POET, "put", 7.5, "2026-08-21", 10, 1.2, 33, "ITM", -0.42, 0.95, 1.15, 1.25, 1.2],
  [BET_IDS.MU, "call", 150, "2026-09-18", 3, 7.5, 61, "OTM", 0.44, 0.58, 7.4, 7.6, 7.5],
  [BET_IDS.NVDA, "call", 200, "2026-08-21", 2, 8.1, 33, "OTM", 0.45, 0.55, 8.0, 8.2, 8.1],
  [BET_IDS.GME, "call", 35, "2026-07-31", 20, 0.95, 12, "OTM", 0.3, 0.9, 0.9, 1.0, 0.95],
] as const;

const BET_SNAPSHOTS = [
  [BET_IDS.RDDT, 178.4, 5.1, 2550, 21.4, 450, 520, -120],
  [BET_IDS.POET, 4.9, 2.7, 2700, 125.0, 1500, 1500, -80],
  [BET_IDS.MU, 146.2, 6.9, 2070, -8.0, -180, 120, -300],
  [BET_IDS.NVDA, 197.1, 7.4, 1480, -8.6, -140, 160, -220],
  [BET_IDS.GME, 33.1, 0.7, 1400, -26.3, -500, 300, -520],
] as const;

const BET_PERFORMANCE = [
  [BET_IDS.RDDT, "RDDT", 21.4, 30.0, -12.0, "winning", 18.0, 0.8],
  [BET_IDS.POET, "POET", 125.0, 140.0, -8.0, "winning", 122.0, 0.65],
  [BET_IDS.MU, "MU", -8.0, 12.0, -30.0, "losing", -11.0, 0.55],
  [BET_IDS.NVDA, "NVDA", -8.6, 16.0, -22.0, "losing", -12.0, 0.4],
  [BET_IDS.GME, "GME", -26.3, 30.0, -52.0, "losing", -30.0, 0.35],
] as const;

/**
 * The demo bets and every child row that hangs off them.
 *
 * One transaction: a bet whose legs failed to write would be rendered as a
 * position with no contracts. Deletes are keyed on the five fixed bet ids, so
 * only rows belonging to these seeded bets are ever removed.
 */
async function seedDemoBets(): Promise<void> {
  for (const bet of BETS) {
    const { id, ...rest } = bet;
    await prisma.bets.upsert({
      where: { id },
      create: {
        id,
        sourceType: "reddit",
        instrument: "option",
        positionIntent: "real_position",
        status: "open",
        metadata: SEED_MARK,
        ...rest,
      },
      update: {
        declaredCapital: rest.declaredCapital,
        verifiedCapital: rest.verifiedCapital,
        verificationLevel: rest.verificationLevel,
        extractionConfidence: rest.extractionConfidence,
        status: "open",
        updatedAt: NOW,
      },
    });
  }

  await prisma.$transaction([
    prisma.betLegs.deleteMany({ where: { betId: { in: ALL_BET_IDS } } }),
    prisma.betLegs.createMany({
      data: BET_LEGS.map(([betId, optionType, strike, expiration, contracts, premium, dte, moneyness, delta, iv, bid, ask, mid]) => ({
        betId,
        legType: "option",
        side: "long",
        optionType,
        strike,
        expirationDate: date(expiration),
        contracts,
        premium,
        price: premium,
        dte,
        moneyness,
        delta,
        impliedVolatility: iv,
        bid,
        ask,
        mid,
      })),
    }),

    prisma.betSnapshots.deleteMany({ where: { betId: { in: ALL_BET_IDS } } }),
    prisma.betSnapshots.createMany({
      data: BET_SNAPSHOTS.map(([betId, underlyingPrice, optionValue, positionValue, returnPct, unrealizedPl, maxGain, maxLoss]) => ({
        betId,
        snapshotAt: NOW,
        underlyingPrice,
        estimatedOptionValue: optionValue,
        estimatedPositionValue: positionValue,
        returnPct,
        unrealizedPl,
        maxGainSoFar: maxGain,
        maxLossSoFar: maxLoss,
        metadata: SEED_MARK,
      })),
    }),

    prisma.betVerifications.deleteMany({ where: { betId: { in: ALL_BET_IDS } } }),
    prisma.betVerifications.createMany({
      data: [
        { betId: BET_IDS.RDDT, verificationLevel: "internally_consistent", method: "premium_vs_chain", passed: true, detail: { expected: 4.2, observed: 4.2 } },
        { betId: BET_IDS.MU, verificationLevel: "market_validated", method: "chain_lookup", passed: true, detail: { strike_found: true } },
        { betId: BET_IDS.GME, verificationLevel: "screenshot_detected", method: "ocr_stub", passed: true, detail: { attachment: "screenshot" } },
      ],
    }),

    prisma.betLifecycleEvents.deleteMany({ where: { betId: { in: ALL_BET_IDS } } }),
    prisma.betLifecycleEvents.createMany({
      data: [
        { betId: BET_IDS.RDDT, eventType: "opened", detail: { note: "initial position" }, occurredAt: minutesAgo(55) },
        { betId: BET_IDS.RDDT, eventType: "snapshot", detail: { return_pct: 21.4 }, occurredAt: NOW },
        { betId: BET_IDS.POET, eventType: "opened", detail: { note: "put entry" }, occurredAt: minutesAgo(45) },
        { betId: BET_IDS.GME, eventType: "opened", detail: { note: "lotto calls" }, occurredAt: minutesAgo(20) },
      ],
    }),

    prisma.betPerformance.deleteMany({ where: { betId: { in: ALL_BET_IDS } } }),
    prisma.betPerformance.createMany({
      data: BET_PERFORMANCE.map(([betId, ticker, realized, peak, trough, outcome, spyAdjusted, earlyLate]) => ({
        betId,
        ticker,
        realizedReturnPct: realized,
        peakReturnPct: peak,
        troughReturnPct: trough,
        outcome,
        spyAdjustedReturn: spyAdjusted,
        earlyLateScore: earlyLate,
        resolvedAt: null,
        metadata: SEED_MARK,
      })),
    }),
  ]);

  log(`apuestas demo: ${BETS.length} con patas, snapshots y rendimiento`);
}

// ── 3f. Demo analytics, backtests and research ───────────────────────────────

const SIGNAL_SCORES = [
  ["RDDT", "direction_1h", 62, 0.6, "Bullish call flow and rising mentions.", { mentions: 42, calls: 5 }],
  ["RDDT", "direction_24h", 58, 0.55, "Sustained bullish attention over 24h.", { mentions_24h: 320 }],
  ["POET", "pump_risk", 85, 0.7, "Coordinated promotional language on a penny name.", { phrases: 3 }],
  ["NVDA", "contrarian", 54, 0.45, "Crowded bullish tape; contrarian signal weak, low confidence.", { call_ratio: 0.78, sample: 66 }],
  ["MU", "direction_1h", 66, 0.62, "Bullish momentum confirmation with real bets.", { verified_bets: 1 }],
] as const;

const POSITIONING = [
  ["RDDT", 0.78, 0.1, 0.68, 21000, 18000, 33, 0.48, 21000, 0.66, { "2026-08-21": 21000 }],
  ["POET", 0.15, 0.72, -0.57, 12000, 0, 33, 0.42, 12000, -0.5, { "2026-08-21": 12000 }],
  ["MU", 0.7, 0.12, 0.58, 9000, 9000, 61, 0.44, 9000, 0.55, { "2026-09-18": 9000 }],
  ["NVDA", 0.66, 0.2, 0.46, 16000, 12000, 33, 0.45, 16000, 0.4, { "2026-08-21": 16000 }],
  ["GME", 0.8, 0.05, 0.75, 19000, 0, 12, 0.3, 19000, 0.6, { "2026-07-31": 19000 }],
] as const;

const PUMP_SCORES = [
  ["POET", 85, "high", ["to the moon", "easy 10x", "buy now"], 0.62, 0.35, ["wallstreetbets", "pennystocks"], 0.18, "Repeated promotional phrases, concentrated authors, new accounts, and deletions."],
  ["GME", 40, "medium", ["diamond hands"], 0.3, 0.1, ["wallstreetbets"], 0.05, "Some repetition but organic meme revival."],
] as const;

const DD_SCORES = [
  ["dev_post_rddt_001", "RDDT", 78, 0.8, 0.7, 0.8, 0.9, 0.7, 0.6, "high_quality", "Numbers, source (10-Q), catalyst, and risk disclosed."],
  ["dev_post_mu_001", "MU", 72, 0.7, 0.6, 0.9, 0.8, 0.7, 0.6, "high_quality", "DCF, catalyst, risk disclosed."],
  ["dev_post_poet_001", "POET", 14, 0.1, 0.0, 0.0, 0.1, 0.0, 0.1, "low_quality", "Hype only, no numbers, no sources, no risk disclosure."],
] as const;

async function seedDemoAnalytics(): Promise<void> {
  for (const [ticker, signalType, score, confidence, explanation, evidence] of SIGNAL_SCORES) {
    const values = { score, confidence, explanation, evidence: { ...evidence, ...SEED_MARK } };
    await prisma.signalScores.upsert({
      where: { ticker_bucketStart_signalType: { ticker, bucketStart: HOUR_BUCKET, signalType } },
      create: { ticker, bucketStart: HOUR_BUCKET, signalType, ...values },
      update: values,
    });
  }

  for (const [ticker, callConviction, putConviction, netDirectionalConviction, declaredYoloCapital, verifiedYoloCapital, averageDte, averageMoneyness, premiumAtRisk, leveragedSentiment, expirationWall] of POSITIONING) {
    const values = { callConviction, putConviction, netDirectionalConviction, declaredYoloCapital, verifiedYoloCapital, averageDte, premiumAtRisk, leveragedSentiment, expirationWall };
    await prisma.tickerPositioningIndexes.upsert({
      where: { ticker_bucketStart: { ticker, bucketStart: HOUR_BUCKET } },
      create: { ticker, bucketStart: HOUR_BUCKET, averageMoneyness, ...values },
      update: values,
    });
  }

  for (const [ticker, score, severity, phrases, authorConcentration, newAccountRatio, subreddits, deletionRate, explanation] of PUMP_SCORES) {
    const values = { score, severity, repeatedPhrases: [...phrases], authorConcentration, newAccountRatio, deletionRate, explanation };
    await prisma.pumpCoordinationScores.upsert({
      where: { ticker_bucketStart: { ticker, bucketStart: HOUR_BUCKET } },
      create: { ticker, bucketStart: HOUR_BUCKET, crossSubredditActivity: { subreddits: [...subreddits] }, ...values },
      update: values,
    });
  }

  for (const [redditPostId, ticker, score, evidence, source, calculation, catalyst, risk, originality, category, explanation] of DD_SCORES) {
    await prisma.ddQualityScores.upsert({
      where: { redditPostId },
      create: {
        redditPostId,
        ticker,
        score,
        evidenceScore: evidence,
        sourceScore: source,
        calculationScore: calculation,
        catalystScore: catalyst,
        riskDisclosureScore: risk,
        originalityScore: originality,
        category,
        explanation,
      },
      update: { score, category, explanation },
    });
  }

  const seedOwned = {
    OR: [
      { metadata: { path: ["seedKey"], equals: SEED_KEY } },
      { metadata: { path: ["seed"], equals: true } },
    ],
  };

  await prisma.$transaction([
    prisma.narrativeEvents.deleteMany({ where: seedOwned }),
    prisma.narrativeEvents.createMany({
      data: [
        { ticker: "RDDT", narrative: "Earnings beat and guidance raise", narrativeType: "fundamental", strength: 0.7, metadata: SEED_MARK },
        { ticker: "MU", narrative: "HBM / memory super-cycle", narrativeType: "fundamental", strength: 0.8, metadata: SEED_MARK },
        { ticker: "POET", narrative: "Imminent short squeeze", narrativeType: "speculative", strength: 0.6, metadata: SEED_MARK },
        { ticker: "GME", narrative: "Meme revival", narrativeType: "meme", strength: 0.5, metadata: SEED_MARK },
      ],
    }),

    prisma.narrativeTransitions.deleteMany({ where: seedOwned }),
    prisma.narrativeTransitions.createMany({
      data: [
        { ticker: "NVDA", fromNarrative: "AI leader", toNarrative: "Too crowded / profit taking", confidence: 0.55, metadata: SEED_MARK },
        { ticker: "POET", fromNarrative: "Turnaround story", toNarrative: "Pump and dump risk", confidence: 0.6, metadata: SEED_MARK },
      ],
    }),

    prisma.betaAdjustedResults.deleteMany({ where: { signalRef: { startsWith: "seed_" } } }),
    prisma.betaAdjustedResults.createMany({
      data: [
        { ticker: "RDDT", signalRef: "seed_rddt", windowDays: 7, rawReturn: 14.0, spyReturn: 1.2, beta: 1.35, betaAdjustedReturn: 12.4 },
        { ticker: "MU", signalRef: "seed_mu", windowDays: 14, rawReturn: 22.5, spyReturn: 2.0, beta: 1.15, betaAdjustedReturn: 20.2 },
        { ticker: "NVDA", signalRef: "seed_nvda", windowDays: 7, rawReturn: -6.0, spyReturn: 1.0, beta: 1.6, betaAdjustedReturn: -7.6 },
      ],
    }),
  ]);

  // backtest_results cascade from their run.
  await prisma.backtestRuns.deleteMany({
    where: {
      OR: [
        { query: { path: ["seedKey"], equals: SEED_KEY } },
        { query: { path: ["seed"], equals: true } },
      ],
    },
  });
  await prisma.backtestRuns.create({
    data: {
      name: "Verified bullish call bets, 7d hold",
      query: {
        ...SEED_MARK,
        filters: {
          direction: "bullish",
          instrument: "option",
          min_verification: "internally_consistent",
        },
        hold_days: 7,
      },
      backtestResults: {
        create: {
          observations: 128,
          winRate: 0.54,
          medianReturn: 6.2,
          averageReturn: 11.8,
          maxDrawdown: -42.0,
          spyAdjustedReturn: 8.9,
          optionEstimatedReturn: 34.5,
          resultDistribution: {
            buckets: [
              { range: "-100..-50", n: 22 },
              { range: "-50..0", n: 34 },
              { range: "0..50", n: 48 },
              { range: "50..200", n: 24 },
            ],
          },
        },
      },
    },
  });

  const reports = [
    {
      slug: "weekly-retail-bet-recap",
      title: "Weekly Retail Bet Recap",
      summary: "Where retail actually put money this week, not just what they talked about.",
      body: "# Weekly Retail Bet Recap\n\nDeclared call capital concentrated in RDDT and NVDA. POET showed pump-coordination red flags. Verified bets skew bullish with a 54% historical win rate on the 7-day hold.\n\n*Signals are informational only, not investment advice.*",
      reportType: "weekly_recap",
      tickers: ["RDDT", "NVDA", "POET"],
    },
    {
      slug: "wsb-vs-real-results",
      title: "Retail vs Real Results",
      summary: "How closely did realized option outcomes track the crowd's conviction?",
      body: "# Retail vs Real Results\n\nHigh-conviction bullish positioning modestly outperformed SPY on a beta-adjusted basis, but penny-name hype (POET) underperformed once coordination faded.\n\n*Signals are informational only, not investment advice.*",
      reportType: "analysis",
      tickers: ["RDDT", "MU", "POET", "GME"],
    },
  ];

  for (const report of reports) {
    const { slug, reportType, ...values } = report;
    await prisma.researchReports.upsert({
      where: { slug },
      create: { slug, reportType, metadata: SEED_MARK, ...values },
      update: values,
    });
  }

  log("analitica, backtests e informes demo");
}

// ── 3g. Demo product data for the placeholder owner ──────────────────────────

/**
 * Watchlist, positions, alert rules, summary and webhook for DEMO_OWNER_ID.
 *
 * These tables key on a free-text user_id, so this placeholder uuid is not a
 * real account. Every delete is scoped to it, so a real user's watchlist, alert
 * rules or webhooks are never touched.
 */
async function seedDemoProductData(): Promise<void> {
  await prisma.userWatchlists.upsert({
    where: { userId_name: { userId: DEMO_OWNER_ID, name: "My Watchlist" } },
    create: { id: DEMO_WATCHLIST_ID, userId: DEMO_OWNER_ID, name: "My Watchlist" },
    update: {},
  });

  for (const ticker of ["RDDT", "MU", "GME"]) {
    await prisma.userWatchlistItems.upsert({
      where: { watchlistId_ticker: { watchlistId: DEMO_WATCHLIST_ID, ticker } },
      create: { watchlistId: DEMO_WATCHLIST_ID, ticker },
      update: {},
    });
  }

  await prisma.$transaction([
    prisma.userPortfolioPositions.deleteMany({ where: { userId: DEMO_OWNER_ID } }),
    prisma.userPortfolioPositions.createMany({
      data: [
        { userId: DEMO_OWNER_ID, ticker: "RDDT", quantity: 30, avgCost: 150.0, instrument: "stock", openedAt: daysAgo(30), metadata: { ...SEED_MARK, linked_signal: "direction_1h" } },
        { userId: DEMO_OWNER_ID, ticker: "MU", quantity: 20, avgCost: 130.0, instrument: "stock", openedAt: daysAgo(20), metadata: { ...SEED_MARK, linked_signal: "direction_1h" } },
        { userId: DEMO_OWNER_ID, ticker: "GME", quantity: 50, avgCost: 28.0, instrument: "stock", openedAt: daysAgo(60), metadata: { ...SEED_MARK, linked_signal: "pump_risk" } },
      ],
    }),

    prisma.userAlertRules.deleteMany({ where: { userId: DEMO_OWNER_ID } }),
    prisma.userAlertRules.createMany({
      data: [
        { userId: DEMO_OWNER_ID, name: "POET pump watch", ruleType: "possible_coordination", ticker: "POET", params: { min_score: 70 }, isActive: true },
        { userId: DEMO_OWNER_ID, name: "RDDT call capital", ruleType: "declared_call_capital_spike", ticker: "RDDT", params: { min_delta_pct: 100 }, isActive: true },
      ],
    }),

    prisma.webhookSubscriptions.deleteMany({ where: { userId: DEMO_OWNER_ID } }),
    prisma.webhookSubscriptions.createMany({
      data: [
        { userId: DEMO_OWNER_ID, targetUrl: "https://example.com/webhooks/yolopulse", eventTypes: ["alert.created", "bet.verified"], isActive: true },
      ],
    }),
  ]);

  const summary = {
    summary:
      "Retail leaned bullish today. RDDT and MU led verified call capital; POET flashed coordination risk.",
    highlights: [
      "RDDT verified call capital up",
      "POET possible coordination (high)",
      "GME expiration wall 07/31",
    ],
  };
  await prisma.dailySummaries.upsert({
    where: { userId_day: { userId: DEMO_OWNER_ID, day: TODAY } },
    create: { userId: DEMO_OWNER_ID, day: TODAY, ...summary },
    update: summary,
  });

  log("datos de producto demo (watchlist, posiciones, alertas, webhook)");
}

// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // Reference data — always.
  console.log("🌱 Datos de referencia");
  await seedReferenceTickers();

  // Default application configuration — always.
  console.log("⚙️  Configuracion por defecto");
  await seedDefaultCompetition();

  // Development/demo content — opt-in, never in production.
  if (!demoSeedAllowed) {
    const motivo = isProduction
      ? "NODE_ENV=production (los datos demo estan prohibidos)"
      : `SEED_DEMO_DATA=${env.SEED_DEMO_DATA}`;
    console.log(`⏭️  Datos demo omitidos — ${motivo}`);
    return;
  }

  console.log("🧪 Datos demo (SEED_DEMO_DATA=true)");
  await seedDemoUsers();
  await seedDemoSocial();
  await seedDemoMetrics();
  await seedDemoMarketData();
  await seedDemoBets();
  await seedDemoAnalytics();
  await seedDemoProductData();
  await seedDemoLeaderboard();
}

main()
  .then(() => {
    console.log("✅ Seed completado.");
  })
  .catch((error: unknown) => {
    // Only the message — a Prisma error can carry query parameters, and the
    // connection string must never reach the logs.
    console.error(
      "Seed failed:",
      error instanceof Prisma.PrismaClientKnownRequestError
        ? `${error.code} — ${error.message.split("\n")[0]}`
        : error instanceof Error
          ? error.message
          : "unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
