-- Match-first: a binding that adopted an operator-created asset keeps the
-- operator's asset name on later syncs; integration-created assets do not.
-- AlterTable
ALTER TABLE "integration_sync_records" ADD COLUMN "adopted" BOOLEAN NOT NULL DEFAULT false;
