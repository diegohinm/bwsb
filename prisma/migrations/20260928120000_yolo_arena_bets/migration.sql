-- YOLO ARENA — user-created predictions, and scoring columns for WSB banbets.
--
-- Two ecosystems, deliberately kept apart. A banbet was made under r/wallstreetbets'
-- rules on Reddit; a YoloBet was made under ours, with an entry price we froze
-- ourselves. Their scores are never summed into one number, so the tables stay
-- separate rather than sharing one polymorphic "bet" table with a type column
-- that every query would then have to remember to filter on.

CREATE TABLE IF NOT EXISTS yolo_bets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  ticker              text NOT NULL,

  -- 'up' | 'down'. Derived server-side from entry vs target, never trusted
  -- from the client, so it cannot disagree with the prices beside it.
  direction           text NOT NULL,

  -- THE FROZEN ENTRY. Captured from a fresh quote at creation and never
  -- rewritten: an editable entry price is a time machine.
  entry_price         numeric NOT NULL,
  entry_timestamp     timestamptz NOT NULL,
  -- When the QUOTE was observed, which is not when the bet was placed. Kept
  -- separately so a stale-price dispute can be settled from the row itself.
  market_data_timestamp timestamptz,

  target_price        numeric NOT NULL,
  expires_at          timestamptz NOT NULL,

  -- 'active' | 'won' | 'lost' | 'cancelled'
  status              text NOT NULL DEFAULT 'active',
  resolved_at         timestamptz,
  -- The price that settled it: the high that touched an up target, the low
  -- that touched a down one, or the last close at expiry.
  result_price        numeric,

  -- THE SCORE, COMPONENT BY COMPONENT. Storing only the total would make a
  -- past score unauditable and a formula change unreviewable.
  volatility_at_entry numeric,
  target_move         numeric,
  expected_move       numeric,
  difficulty          numeric,
  raw_score           numeric,
  score_delta         numeric,
  -- Which formula produced them. Historical rows keep their own version, so a
  -- future v2 is introduced beside v1 rather than silently rewriting history.
  scoring_version     text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT yolo_bets_direction_check CHECK (direction IN ('up','down')),
  CONSTRAINT yolo_bets_status_check CHECK (status IN ('active','won','lost','cancelled')),
  CONSTRAINT yolo_bets_entry_positive CHECK (entry_price > 0),
  CONSTRAINT yolo_bets_target_positive CHECK (target_price > 0),
  CONSTRAINT yolo_bets_window_check CHECK (expires_at > entry_timestamp)
);

-- ONE ACTIVE BET PER USER PER TICKER, enforced by the database rather than by
-- a check in the handler. Two contradictory open calls on META (to $900 and to
-- $500) guarantee one winner whatever happens, which is not a prediction.
-- Partial, so resolved history is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS yolo_bets_one_active_per_ticker
  ON yolo_bets (user_id, ticker)
  WHERE status = 'active';

-- The resolver's sweep: open bets whose deadline has passed.
CREATE INDEX IF NOT EXISTS yolo_bets_status_expires_idx ON yolo_bets (status, expires_at);
-- The leaderboard groups by user over a window keyed on RESOLUTION time.
CREATE INDEX IF NOT EXISTS yolo_bets_user_resolved_idx ON yolo_bets (user_id, resolved_at DESC);
-- Period windows scan by resolution date across all users.
CREATE INDEX IF NOT EXISTS yolo_bets_resolved_idx ON yolo_bets (resolved_at DESC) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS yolo_bets_ticker_idx ON yolo_bets (ticker, created_at DESC);

-- ── Banbet scoring ────────────────────────────────────────────────────────
-- The same components on the WSB side. Nullable throughout: a historical
-- banbet whose volatility cannot be reconstructed shows N/A rather than a
-- fabricated score, and `scoring_version` NULL is how "unscored" is spelled.
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS entry_price numeric;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS volatility_at_entry numeric;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS target_move numeric;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS expected_move numeric;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS difficulty numeric;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS raw_score numeric;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS score_delta numeric;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS scoring_version text;
-- The bot reply that confirms WSB accepted the bet. Without evidence of
-- acceptance a !banbet comment is a candidate, not a record.
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS bot_reply_comment_id text;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS reddit_comment_id text;
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS reddit_post_id text;
-- 'candidate' | 'confirmed'. Only confirmed rows reach the leaderboard.
ALTER TABLE wsb_banbets ADD COLUMN IF NOT EXISTS confirmation text NOT NULL DEFAULT 'candidate';

CREATE INDEX IF NOT EXISTS wsb_banbets_resolved_idx
  ON wsb_banbets (resolved_at DESC) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS wsb_banbets_confirmation_idx
  ON wsb_banbets (confirmation, status);
