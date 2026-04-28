-- Alerts: replace `alert_config.recipient_email` (single TEXT) with
-- `recipient_emails` (TEXT[]) so a single config can fan out to a
-- team alias plus an on-call inbox, etc. Existing single-recipient
-- rows are migrated by wrapping the old value in a one-element array.

ALTER TABLE "alert_config"
  ADD COLUMN "recipient_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "alert_config"
  SET "recipient_emails" = ARRAY["recipient_email"]
  WHERE "recipient_email" IS NOT NULL AND "recipient_email" <> '';

ALTER TABLE "alert_config" DROP COLUMN "recipient_email";
