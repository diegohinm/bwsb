-- Bring every account without a picture of its own onto the one default avatar.
--
-- The asset lives at fwsb/public/avatars/default-frog.svg and is served from
-- `/avatars/default-frog.svg`. That exact string is the value written by
-- bwsb/src/config/branding.ts (DEFAULT_AVATAR_URL), so the database and the
-- frontend helper cannot disagree about which file is meant.
--
-- CUSTOM AVATARS ARE NEVER TOUCHED. The WHERE clauses below only match rows
-- that have no picture at all, or that still carry one of the retired
-- placeholder URLs. Anything a user actually uploaded is left exactly as it is.
--
-- Idempotent: re-running changes nothing, because every row it would write
-- already holds the values it would write.

-- 1. No avatar at all — null, empty, or whitespace.
UPDATE "app_users"
   SET "avatar_url"  = '/avatars/default-frog.svg',
       "avatar_type" = 'default_frog',
       "updated_at"  = now()
 WHERE "avatar_url" IS NULL
    OR btrim("avatar_url") = '';

-- 2. Already on the default image, but labelled with an older type string.
--    One row carried `default` rather than `default_frog`, which would make any
--    query that groups by type report two different defaults.
UPDATE "app_users"
   SET "avatar_type" = 'default_frog',
       "updated_at"  = now()
 WHERE "avatar_url" = '/avatars/default-frog.svg'
   AND ("avatar_type" IS DISTINCT FROM 'default_frog');
