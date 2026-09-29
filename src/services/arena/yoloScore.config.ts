/**
 * YOLO SCORE — the tunable constants, in one place.
 *
 * Read from the environment with documented defaults rather than written into
 * the formula, because every one of them is a product judgement that will be
 * argued about: how fast the reward curve flattens, how hard a loss bites, how
 * far a single bet may move a leaderboard. A constant buried in an expression
 * is a judgement nobody can find.
 *
 * Changing any of these changes what a score MEANS, which is why
 * `YOLO_SCORING_VERSION` exists beside them. Bump it whenever a value here
 * changes, or historical bets silently start describing a different formula.
 */

function envNumber(name: string, fallback: number, { min, max }: { min: number; max: number }) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    // A typo in an env var must not silently reshape the leaderboard.
    throw new Error(
      `${name} must be a finite number between ${min} and ${max} (received ${JSON.stringify(raw)})`,
    );
  }
  return parsed;
}

export const YOLO_SCORE_CONFIG = {
  /**
   * Curve flattening. `rawScore = 100 * difficulty ** exponent`.
   *
   * Below 1 so a 10x-expected-move call is worth ~6x a 1x call rather than 10x:
   * absurd targets stay valuable without letting one lottery ticket own the
   * board forever.
   */
  difficultyExponent: envNumber("YOLO_SCORE_DIFFICULTY_EXPONENT", 0.8, { min: 0.1, max: 3 }),

  /**
   * What a loss costs, as a fraction of what the win would have paid.
   *
   * Deliberately NOT 1.0. A full-price loss makes the optimal strategy "never
   * take an interesting bet", which is the opposite of the point; 0 makes the
   * optimal strategy "fire impossible targets until one lands". A quarter keeps
   * both failure modes unattractive.
   */
  lossMultiplier: envNumber("YOLO_SCORE_LOSS_MULTIPLIER", 0.25, { min: 0, max: 1 }),

  /** Ceiling per bet, so one freak call cannot permanently end the contest. */
  maxPerBet: envNumber("YOLO_SCORE_MAX_PER_BET", 1000, { min: 1, max: 1_000_000 }),

  /**
   * Floor on the target move, as a percentage of entry. Guards against
   * "SPY to +0.01% in 30 days" farming a positive score for predicting noise.
   */
  minTargetMovePercent: envNumber("YOLO_MIN_TARGET_MOVE_PERCENT", 1, { min: 0, max: 100 }),

  /** Resolved bets required before a user is ranked rather than PROVISIONAL. */
  minResolvedBetsForRanking: envNumber("YOLO_MIN_RESOLVED_BETS_FOR_RANKING", 3, {
    min: 1,
    max: 1000,
  }),

  /** Deadline bounds for a YOLOPulse bet, in minutes. */
  minDeadlineMinutes: envNumber("YOLO_MIN_DEADLINE_MINUTES", 60, { min: 1, max: 525_600 }),
  maxDeadlineMinutes: envNumber("YOLO_MAX_DEADLINE_MINUTES", 365 * 24 * 60, {
    min: 1,
    max: 5_256_000,
  }),

  /** Anti-spam: concurrent ACTIVE bets one account may hold. */
  maxActiveBetsPerUser: envNumber("YOLO_MAX_ACTIVE_BETS_PER_USER", 10, { min: 1, max: 1000 }),

  /**
   * How stale an entry price may be at creation, in minutes. A bet priced off
   * a two-hour-old quote is a bet placed with hindsight.
   */
  maxEntryPriceAgeMinutes: envNumber("YOLO_MAX_ENTRY_PRICE_AGE_MINUTES", 15, {
    min: 1,
    max: 1440,
  }),
} as const;

/**
 * THE SCORING VERSION, stamped onto every scored bet.
 *
 * Bets carry the version they were scored under, so changing the formula never
 * silently rewrites history: v1 rows keep describing the v1 formula, and a
 * future v2 can be introduced beside them rather than on top of them.
 */
export const YOLO_SCORING_VERSION = "v1";

/** Seconds in a 365-day year — the denominator for annualized volatility. */
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
