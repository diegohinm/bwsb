-- Subreddit flair and Reddit's own id for stored social content.
--
-- The provider returns both — `flair` ("Earnings Thread") and `redditId`
-- (`t3_1vi969l`) — and neither had anywhere to go, so both were dropped at the
-- door. Flair is what the feed shows as a badge; the id is what lets a comment
-- permalink be assembled against its parent thread.
--
-- Both are NULLABLE and stay null when the source says nothing. A missing flair
-- renders no badge at all: "N/A" would claim the post had one.

ALTER TABLE "social_posts"
    ADD COLUMN IF NOT EXISTS "flair_text" TEXT,
    ADD COLUMN IF NOT EXISTS "reddit_id"  TEXT;

ALTER TABLE "social_comments"
    ADD COLUMN IF NOT EXISTS "flair_text" TEXT,
    ADD COLUMN IF NOT EXISTS "reddit_id"  TEXT;

-- The summary aggregates mentions per ticker over a time window, twice per
-- request (current period and the comparison period). Without this the hot-
-- ticker query re-scans the table for both.
CREATE INDEX IF NOT EXISTS "social_posts_posted_stance_idx"
    ON "social_posts" ("posted_at" DESC, "stance");
CREATE INDEX IF NOT EXISTS "social_comments_posted_stance_idx"
    ON "social_comments" ("posted_at" DESC, "stance");
