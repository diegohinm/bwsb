-- LOCAL SEARCH, MADE INDEXABLE.
--
-- Discussion search already runs entirely in Postgres — it has never called
-- Mindcase per keystroke. What it could not do was use an index: every term
-- compiles to `column ILIKE '%term%'`, and a leading wildcard makes a B-tree
-- useless, so each search was a sequential scan over social_posts and
-- social_comments.
--
-- pg_trgm indexes THAT pattern directly. The query does not change shape, the
-- read path keeps its Prisma `contains` clauses, and the planner starts using
-- an index for exactly the predicate the UI already sends. This is why trigram
-- was chosen over a tsvector column: full-text search would have required
-- rewriting the read path into raw SQL to gain a ranking the UI does not
-- currently display, and would still not answer a partial-word query like
-- "earn" — which is what someone typing into a search box produces.
--
-- Trigram cannot help a term shorter than three characters; those stay
-- sequential scans, bounded in practice by the window filter that accompanies
-- them.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CONCURRENTLY is deliberately NOT used: Prisma runs each migration inside a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run in one. These tables
-- are worker-written and reader-tolerant of a brief lock during deploy.
CREATE INDEX IF NOT EXISTS "social_posts_title_trgm_idx"
    ON "social_posts" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "social_posts_body_trgm_idx"
    ON "social_posts" USING GIN ("body" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "social_comments_body_trgm_idx"
    ON "social_comments" USING GIN ("body" gin_trgm_ops);

-- Searching a username is an equality-shaped query wearing a LIKE costume:
-- author_hash is a fixed-length digest, so a reader either has the whole thing
-- or is not looking for an author at all. Trigram covers the partial case too.
CREATE INDEX IF NOT EXISTS "social_posts_author_trgm_idx"
    ON "social_posts" USING GIN ("author_hash" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "social_comments_author_trgm_idx"
    ON "social_comments" USING GIN ("author_hash" gin_trgm_ops);

-- Company-name search ("Jensen" finding NVDA posts through the catalog) runs
-- the same ILIKE against a much smaller table, but it runs on every search that
-- names a symbol, so it gets the same treatment.
CREATE INDEX IF NOT EXISTS "tickers_company_name_trgm_idx"
    ON "tickers" USING GIN ("company_name" gin_trgm_ops);
