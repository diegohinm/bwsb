-- Email verification tokens gain a delivery status.
--
-- The bug this fixes: the token was written to the database BEFORE the email
-- was sent, and stayed valid when the send failed. That left a working
-- verification link that nobody could ever receive, while the endpoint returned
-- 200. A token is now created 'pending' and only promoted to 'sent' once the
-- mail server has accepted the message; only 'sent' can complete a
-- verification.
--
-- Existing rows are backfilled to 'sent': they predate this column and were
-- created under the old flow, where reaching the database meant the send had at
-- least been attempted. Invalidating them would break links already in
-- people's inboxes.

ALTER TABLE "email_verification_tokens"
    ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE "email_verification_tokens"
    ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT 'email_registration';

ALTER TABLE "email_verification_tokens"
    ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMPTZ(6);

UPDATE "email_verification_tokens"
   SET "status" = 'sent',
       "sent_at" = COALESCE("sent_at", "created_at")
 WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "email_verification_tokens_user_status_idx"
    ON "email_verification_tokens" ("user_id", "status");
