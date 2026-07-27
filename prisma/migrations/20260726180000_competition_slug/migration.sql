-- Add a stable, human-readable key to competitions.
--
-- The seed upserts the default season on `slug`, so re-running it updates the
-- season in place instead of creating a duplicate. Nullable: seasons created
-- before this column existed have none, and a NOT NULL column would fail on
-- them.

-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "slug" TEXT;

-- Backfill the season the previous seed script created with a fixed UUID.
-- Without this the seed's upsert-on-slug would not find it and would insert a
-- SECOND season, orphaning the participants and leaderboard rows attached to
-- the original.
UPDATE "competitions"
   SET "slug" = 'yolo-arena-season-04'
 WHERE "id" = '40000000-0000-0000-0000-000000000001'
   AND "slug" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "competitions_slug_key" ON "competitions"("slug");
