-- Classify stored posts so "daily discussion" is a stored fact, not a guess.
--
-- WHY A COLUMN AND NOT A TITLE MATCH AT READ TIME
--
-- Matching titles in the query would work, but it puts a `lower(title) LIKE`
-- on the hot path of every daily-discussion request, cannot use an index, and
-- silently changes meaning whenever the pattern list is edited — old rows would
-- start or stop matching with no migration and no record. Classifying once, at
-- ingestion, makes the decision auditable and the read a plain indexed filter.
--
-- The column is deliberately an open TEXT with a CHECK rather than an enum:
-- adding a third category later (weekly threads, moves-only threads) is then a
-- constraint change, not a type migration with a rewrite.

ALTER TABLE "social_posts"
    ADD COLUMN IF NOT EXISTS "post_category" TEXT NOT NULL DEFAULT 'REGULAR';

ALTER TABLE "social_posts"
    DROP CONSTRAINT IF EXISTS "social_posts_post_category_check";

ALTER TABLE "social_posts"
    ADD CONSTRAINT "social_posts_post_category_check"
    CHECK ("post_category" IN ('REGULAR', 'DAILY_DISCUSSION'));

-- Finding the newest daily thread is the one query this feature runs on every
-- request, so it gets an index shaped exactly like that lookup: category and
-- subreddit narrowed, newest first.
CREATE INDEX IF NOT EXISTS "social_posts_daily_discussion_idx"
    ON "social_posts" ("post_category", "subreddit", "posted_at" DESC);

-- Comments are reached through `post_external_id`; without this the join from a
-- resolved thread to its comments is a sequential scan.
CREATE INDEX IF NOT EXISTS "social_comments_post_external_idx"
    ON "social_comments" ("post_external_id", "posted_at" DESC);

-- Backfill what is already stored, using the same patterns the classifier
-- applies at ingestion (services/social/dailyDiscussion.service.ts). Kept in
-- sync deliberately: this runs once, the TypeScript runs forever, and a test
-- asserts the TypeScript against these exact titles.
--
-- Anchored at the start of the title, so "My thoughts on the daily discussion
-- thread" is NOT a daily thread. Scope is r/wallstreetbets only, per spec.
UPDATE "social_posts"
   SET "post_category" = 'DAILY_DISCUSSION'
 WHERE lower("subreddit") = 'wallstreetbets'
   AND "title" IS NOT NULL
   AND (
        regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^what are your moves tomorrow\M'
     OR regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^what are your moves today\M'
     OR regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^daily discussion thread\M'
     OR regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^weekend discussion thread\M'
   );
