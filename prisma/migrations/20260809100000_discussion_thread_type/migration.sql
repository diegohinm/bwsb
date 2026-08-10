-- Which of r/wallstreetbets' three recurring threads a post is.
--
-- `post_category` already says "this is a megathread". This says WHICH one, and
-- they are genuinely different conversations: the morning thread is about the
-- session starting, the evening one about the next session, the weekend one
-- covers two days with no market.
--
-- STORED, NOT DERIVED AT READ TIME. A `title ILIKE '%tomorrow%'` on the hot path
-- cannot use an index, changes meaning silently whenever the pattern list is
-- edited, and would match an ordinary post that mentions tomorrow. The worker
-- decides once, at ingestion; see services/social/dailyDiscussion.service.ts.
--
-- TEXT with a CHECK rather than an enum: adding a fourth thread type later is
-- then a constraint change, not a type migration.

ALTER TABLE "social_posts"
    ADD COLUMN IF NOT EXISTS "discussion_thread_type" TEXT;

ALTER TABLE "social_posts"
    DROP CONSTRAINT IF EXISTS "social_posts_discussion_thread_type_check";
ALTER TABLE "social_posts"
    ADD CONSTRAINT "social_posts_discussion_thread_type_check"
    CHECK ("discussion_thread_type" IS NULL
        OR "discussion_thread_type" IN ('DAILY', 'TOMORROW', 'WEEKEND'));

-- Comments INHERIT the parent thread's type. Denormalized on purpose: the feed
-- filters comments by subtype on every request, and resolving it through a join
-- to the parent each time would make the common query the expensive one.
ALTER TABLE "social_comments"
    ADD COLUMN IF NOT EXISTS "discussion_thread_type" TEXT;

ALTER TABLE "social_comments"
    DROP CONSTRAINT IF EXISTS "social_comments_discussion_thread_type_check";
ALTER TABLE "social_comments"
    ADD CONSTRAINT "social_comments_discussion_thread_type_check"
    CHECK ("discussion_thread_type" IS NULL
        OR "discussion_thread_type" IN ('DAILY', 'TOMORROW', 'WEEKEND'));

-- Finding the ACTIVE thread of a given type is the one query this feature runs
-- per request: newest of its type, in this subreddit.
CREATE INDEX IF NOT EXISTS "social_posts_thread_type_idx"
    ON "social_posts" ("discussion_thread_type", "subreddit", "posted_at" DESC);
CREATE INDEX IF NOT EXISTS "social_comments_thread_type_idx"
    ON "social_comments" ("discussion_thread_type", "posted_at" DESC);

-- Backfill the posts already classified as megathreads, using the same
-- precedence the TypeScript applies: most specific title wins, and a title
-- outranks a flair. A test pins the two against the same real titles.
UPDATE "social_posts"
   SET "discussion_thread_type" = CASE
         WHEN regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^weekend discussion thread\M'          THEN 'WEEKEND'
         WHEN regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^what are your moves this weekend\M'   THEN 'WEEKEND'
         WHEN regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^what are your moves tomorrow\M'       THEN 'TOMORROW'
         WHEN regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^what are your moves today\M'          THEN 'DAILY'
         WHEN regexp_replace(lower(btrim("title")), '\s+', ' ', 'g') ~ '^daily discussion thread\M'            THEN 'DAILY'
         ELSE 'DAILY'
       END
 WHERE "post_category" = 'DAILY_DISCUSSION'
   AND "discussion_thread_type" IS NULL;

-- Comments inherit from the parent post they already point at.
UPDATE "social_comments" c
   SET "discussion_thread_type" = p."discussion_thread_type"
  FROM "social_posts" p
 WHERE c."post_external_id" = p."external_id"
   AND p."discussion_thread_type" IS NOT NULL
   AND c."discussion_thread_type" IS NULL;
