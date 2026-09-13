-- COMMENT PARENT CONTEXT — the reply chain a comment belongs to.
--
-- THE PROBLEM. `social_comments` recorded `post_external_id` (which THREAD a
-- comment is in) and nothing about which COMMENT it answers. In the Discussion
-- feed that made every comment context-free: a row could say only "someone said
-- this, somewhere in that thread", and a reply reading "exactly, and the
-- guidance proves it" was unreadable without opening Reddit. The whole point of
-- the comments view is to be readable without leaving the app.
--
-- WHY THE DATA IS AVAILABLE NOW. Reddit gives every comment a `parent_id`, and
-- the archive returns it — the ingestion path already requests the field. It was
-- simply dropped on the floor for want of a column.
--
-- THE `t1_` / `t3_` DISTINCTION IS THE WHOLE SEMANTICS. Reddit's `parent_id`
-- carries a type prefix:
--
--     t3_<id>   the parent is the POST      → a top-level comment
--     t1_<id>   the parent is a COMMENT     → a reply
--
-- So this column is NULL for top-level comments by design, not by omission:
-- "this comment answers the thread itself" is exactly the absence of a parent
-- comment, and storing the post's id here would make a top-level comment look
-- like a reply to something that is not a comment. Thread membership already
-- has its own column.
--
-- BARE IDS, NO PREFIX, to match `external_id` — the column this is joined
-- against. Storing `t1_p9etgbe` here while `external_id` holds `p9etgbe` would
-- make the join silently match nothing, which is the same failure as having no
-- column at all but harder to notice.
--
-- BACKFILL IS DELIBERATELY ABSENT. Existing rows keep NULL: the value is only
-- recoverable by re-fetching each comment from the archive, and a migration must
-- not depend on a network service being reachable. The read path treats NULL as
-- "not recorded" and renders no parent line, so old rows degrade to exactly the
-- behaviour they have today while every newly ingested comment carries its
-- chain.

ALTER TABLE "social_comments"
    ADD COLUMN IF NOT EXISTS "parent_comment_id" TEXT;

COMMENT ON COLUMN "social_comments"."parent_comment_id" IS
    'Bare Reddit id of the comment this one replies to. NULL for a top-level comment, whose parent is the post itself (see post_external_id).';

-- The read path resolves a page of comments to their parents in ONE batched
-- query (…WHERE external_id = ANY(parents)), and separately walks the other way
-- to count replies. Both directions need this index; without it the feed does a
-- sequential scan per page over a table that grows by every comment in the
-- community.
--
-- Partial, because top-level comments are the majority and they are never the
-- subject of either lookup — indexing their NULLs would enlarge the index for
-- rows no query can match.
CREATE INDEX IF NOT EXISTS "social_comments_parent_comment_idx"
    ON "social_comments" ("parent_comment_id")
    WHERE "parent_comment_id" IS NOT NULL;
