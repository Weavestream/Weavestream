-- Phase 8: Domain & SSL monitor.
--
-- Adds two tenant-scoped tables + two enums.
--
--   monitored_domains  — one row per hostname the MSP watches. The
--                        denormalised `latest_*` columns mirror the
--                        most recent `domain_checks` row so the
--                        list/summary views never join the history
--                        table. Updated by DomainChecksProcessor
--                        inside the same transaction that inserts
--                        the child row.
--   domain_checks      — append-only history. One row per processor
--                        run; kept forever. UI renders the last 30.
--
-- Uniqueness on (company_id, hostname) is enforced only for active
-- rows via a partial unique index so that archiving a domain frees
-- the hostname for a fresh add, matching the article/folder pattern
-- (see D-010).

-- =====================================================================
-- Enums
-- =====================================================================

CREATE TYPE "CheckResult" AS ENUM ('OK', 'WARN', 'FAIL', 'SKIP');
CREATE TYPE "DomainStatus" AS ENUM ('OK', 'EXPIRING', 'EXPIRED', 'FAIL', 'UNKNOWN');

-- =====================================================================
-- monitored_domains
-- =====================================================================

CREATE TABLE "monitored_domains" (
    "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
    "company_id"           UUID         NOT NULL,
    "hostname"             TEXT         NOT NULL,
    "check_whois"          BOOLEAN      NOT NULL DEFAULT true,
    "check_dns"            BOOLEAN      NOT NULL DEFAULT true,
    "check_tls"            BOOLEAN      NOT NULL DEFAULT true,
    "alert_threshold_days" INTEGER      NOT NULL DEFAULT 30,
    "visible_to_clients"   BOOLEAN      NOT NULL DEFAULT false,
    "last_checked_at"      TIMESTAMP(3),
    "whois_expires_at"     TIMESTAMP(3),
    "tls_expires_at"       TIMESTAMP(3),
    "latest_status"        "DomainStatus" NOT NULL DEFAULT 'UNKNOWN',
    "archived_at"          TIMESTAMP(3),
    "created_by"           UUID,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitored_domains_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "monitored_domains"
    ADD CONSTRAINT "monitored_domains_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "monitored_domains_company_archived_idx"
    ON "monitored_domains" ("company_id", "archived_at");

CREATE INDEX "monitored_domains_company_status_idx"
    ON "monitored_domains" ("company_id", "latest_status");

-- Partial unique index so archived rows don't block re-adding a
-- hostname in the same tenant. Mirrors the article slug pattern.
CREATE UNIQUE INDEX "monitored_domains_company_hostname_active"
    ON "monitored_domains" ("company_id", "hostname")
    WHERE "archived_at" IS NULL;

-- =====================================================================
-- domain_checks
-- =====================================================================

CREATE TABLE "domain_checks" (
    "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
    "monitored_domain_id"  UUID         NOT NULL,
    "company_id"           UUID         NOT NULL,
    "checked_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "whois_status"         "CheckResult",
    "dns_status"           "CheckResult",
    "tls_status"           "CheckResult",
    "whois_expires_at"     TIMESTAMP(3),
    "tls_expires_at"       TIMESTAMP(3),
    "details"              JSONB        NOT NULL,
    "error"                TEXT,

    CONSTRAINT "domain_checks_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "domain_checks"
    ADD CONSTRAINT "domain_checks_monitored_domain_id_fkey"
    FOREIGN KEY ("monitored_domain_id") REFERENCES "monitored_domains"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "domain_checks_domain_recent_idx"
    ON "domain_checks" ("monitored_domain_id", "checked_at" DESC);

CREATE INDEX "domain_checks_company_recent_idx"
    ON "domain_checks" ("company_id", "checked_at" DESC);

-- =====================================================================
-- search_index sync (Phase 6 + Phase 8)
-- =====================================================================
--
-- monitored_domains are searchable by hostname. The body is intentionally
-- minimal (hostname + latest_status as text) because there is no long-form
-- description to index — the sidebar search should match "example.com"
-- verbatim and nothing else.
--
-- visibility rule mirrors Articles:
--   visible_to_clients = false  →  body_public stays empty so a client
--                                  query can never match the row.
--   visible_to_clients = true   →  hostname replicated into body_public.
--
-- archived_at is propagated so the search layer's "hide archived" filter
-- works identically across entity types.

CREATE OR REPLACE FUNCTION search_index_upsert_monitored_domain()
RETURNS trigger AS $$
BEGIN
    INSERT INTO "search_index" (
        "entity_type", "entity_id", "company_id", "title",
        "body_public", "body_internal", "visible_to_clients",
        "layout_id", "archived_at", "updated_at"
    ) VALUES (
        'domain',
        NEW."id",
        NEW."company_id",
        NEW."hostname",
        CASE WHEN NEW."visible_to_clients" THEN NEW."hostname" ELSE '' END,
        NEW."hostname" || ' ' || NEW."latest_status"::text,
        NEW."visible_to_clients",
        NULL,
        NEW."archived_at",
        NEW."updated_at"
    )
    ON CONFLICT ("entity_type", "entity_id") DO UPDATE
    SET "company_id"         = EXCLUDED."company_id",
        "title"              = EXCLUDED."title",
        "body_public"        = EXCLUDED."body_public",
        "body_internal"      = EXCLUDED."body_internal",
        "visible_to_clients" = EXCLUDED."visible_to_clients",
        "archived_at"        = EXCLUDED."archived_at",
        "updated_at"         = EXCLUDED."updated_at";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION search_index_delete_monitored_domain()
RETURNS trigger AS $$
BEGIN
    DELETE FROM "search_index"
    WHERE "entity_type" = 'domain' AND "entity_id" = OLD."id";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "monitored_domains_search_index_aiu"
AFTER INSERT OR UPDATE ON "monitored_domains"
FOR EACH ROW EXECUTE FUNCTION search_index_upsert_monitored_domain();

CREATE TRIGGER "monitored_domains_search_index_ad"
AFTER DELETE ON "monitored_domains"
FOR EACH ROW EXECUTE FUNCTION search_index_delete_monitored_domain();
