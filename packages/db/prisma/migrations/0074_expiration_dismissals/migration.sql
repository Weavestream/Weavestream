-- Per-item, per-due-date dismissals for the Expiring-soon feed.
CREATE TABLE "expiration_dismissals" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "dismissed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expiration_dismissals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "expiration_dismissals_item_due_key" ON "expiration_dismissals"("kind", "entity_id", "source", "due_at");
CREATE INDEX "expiration_dismissals_company_idx" ON "expiration_dismissals"("company_id");
ALTER TABLE "expiration_dismissals" ADD CONSTRAINT "expiration_dismissals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
