-- Provider provenance for Reddit content.
--
-- The configurable Reddit provider layer (src/providers/reddit/: Mindcase
-- and/or Arctic Shift) writes into the EXISTING `reddit_posts` /
-- `reddit_comments` tables — the spine of the bet-extraction pipeline — rather
-- than into a parallel copy. Two reasons:
--
--   1. `reddit_post_id` / `reddit_comment_id` already hold the real Reddit id,
--      so an upsert on that key is inherently duplicate-free: Mindcase and
--      Arctic Shift returning the same post resolve to ONE row, with both
--      providers recorded in `sources`.
--   2. Bets, DD-quality scores, ticker mentions and stance events all reference
--      `reddit_posts`. A second table would have split the pipeline in half.
--
-- Every column added here is NULLABLE (or has a default), so existing rows stay
-- valid and nothing already ingested is rewritten. No data is deleted.

-- AlterTable
ALTER TABLE "reddit_posts"
    ADD COLUMN "fullname"     TEXT,
    ADD COLUMN "url"          TEXT,
    ADD COLUMN "upvote_ratio" DECIMAL,
    ADD COLUMN "source"       TEXT,
    ADD COLUMN "sources"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "fetched_at"   TIMESTAMPTZ(6),
    ADD COLUMN "last_seen_at" TIMESTAMPTZ(6),
    ADD COLUMN "raw_data"     JSONB;

-- AlterTable
ALTER TABLE "reddit_comments"
    ADD COLUMN "fullname"     TEXT,
    ADD COLUMN "parent_id"    TEXT,
    ADD COLUMN "permalink"    TEXT,
    ADD COLUMN "source"       TEXT,
    ADD COLUMN "sources"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "fetched_at"   TIMESTAMPTZ(6),
    ADD COLUMN "last_seen_at" TIMESTAMPTZ(6),
    ADD COLUMN "raw_data"     JSONB;

-- CreateIndex
-- The ingestion worker reads "newest post in r/<sub>" on every run to decide
-- how far back to fetch; without this it is a full scan of the table.
CREATE INDEX "reddit_posts_subreddit_created_idx"
    ON "reddit_posts"("subreddit", "reddit_created_at" DESC);

-- CreateIndex
CREATE INDEX "reddit_comments_subreddit_created_idx"
    ON "reddit_comments"("subreddit", "reddit_created_at" DESC);

-- Both tables already have ROW LEVEL SECURITY enabled (0_init); adding columns
-- does not change that, and no new table is created here.
