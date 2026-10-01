-- Which API key performed an audited action (NULL for interactive sessions).
-- No foreign key: the audit trail must outlive the key it names.
ALTER TABLE "audit_log" ADD COLUMN "api_key_id" UUID;
CREATE INDEX "audit_log_api_key_id_idx" ON "audit_log" ("api_key_id") WHERE "api_key_id" IS NOT NULL;
