-- Phase 9: enforce audit_log immutability at the database level.
--
-- Application code only ever INSERTs into audit_log, but a compromised
-- API process or a stray ad-hoc psql session could still UPDATE/DELETE
-- rows and quietly rewrite history. Move the invariant to the database
-- so any UPDATE or DELETE — Prisma, raw SQL, manual psql — fails fast
-- with a clear error.
--
-- INSERT and TRUNCATE are deliberately not blocked:
--   * INSERT is the only legal write path used by the API.
--   * TRUNCATE bypasses row-level triggers by design and is required
--     for `pg_dump --clean` / restore tooling. Operators who need to
--     truncate audit_log already have superuser-level access.
--
-- Escape hatch for backup/restore tooling that needs to rewrite rows
-- (e.g. anonymising audit data before sharing a dump):
--
--   ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete;
--   -- ... perform UPDATE/DELETE ...
--   ALTER TABLE audit_log ENABLE TRIGGER  audit_log_no_update_delete;
--
-- Documented in docs/INSTALL.md (Backups section). Disabling triggers
-- requires the table owner role; non-superuser app users cannot bypass
-- the protection.
--
-- Idempotent: CREATE OR REPLACE on the function and DROP TRIGGER IF
-- EXISTS ahead of CREATE TRIGGER make this migration safe to replay
-- against a database where it has already been applied.

CREATE OR REPLACE FUNCTION audit_log_block_mutations() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only'
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON "audit_log";

CREATE TRIGGER audit_log_no_update_delete
    BEFORE UPDATE OR DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutations();
