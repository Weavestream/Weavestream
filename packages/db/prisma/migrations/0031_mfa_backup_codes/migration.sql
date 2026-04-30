CREATE TABLE "user_mfa_backup_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "code_hash" TEXT NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_mfa_backup_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_mfa_backup_codes_user_id_idx"
  ON "user_mfa_backup_codes"("user_id");

CREATE INDEX "user_mfa_backup_codes_user_id_consumed_at_idx"
  ON "user_mfa_backup_codes"("user_id", "consumed_at");

ALTER TABLE "user_mfa_backup_codes"
  ADD CONSTRAINT "user_mfa_backup_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
