-- Asset external identity was guarded only by the application-level
-- pre-check (`assertExternalIdFree`), so two writers racing past the
-- check together could commit duplicate (company_id, external_source,
-- external_id) rows: overlapping incremental sync runs (a manual and a
-- scheduled run of the same integration are intentionally not
-- single-flighted), two integrations sharing an external source, or an
-- interactive save racing a reconstruction write. Existing deployments
-- may already carry duplicates from that window.
--
-- Concurrency during deploy is real: compose upgrades recreate the api
-- (which runs `migrate deploy`) while the previous worker container is
-- still up — and it keeps STARTING fresh 60s page transactions until
-- the new api reports healthy, so no in-migration wait of any length
-- guarantees convergence (a new transaction can begin near the end of
-- any window). Stopping the worker first (`docker compose stop
-- worker`) makes the dedup residue-free; otherwise the short drain at
-- the bottom converges the common case and
-- `IdentityRetargetDrainService` (api + worker boot, riding the
-- durable helper table) retries in the background with unbounded
-- patience — it outlives the old worker, whose replacement is what
-- actually ends the contention. Keeping the in-migration drain short
-- matters for the same reason: api-healthy is the trigger for that
-- replacement, so a long drain here would prolong the contention it
-- waits out.

-- Explicit transaction: Postgres only holds a table lock to end of
-- statement outside a transaction block (LOCK requires one), and the
-- runner's whole-file-as-one-batch behavior is unspecified. Under the
-- observed batch behavior BEGIN silently promotes the implicit block
-- (PG >= 11); if a future runner executes statements individually, the
-- explicit block still makes the lock span the dedup and index build.
BEGIN;

-- A deployment-side ambient statement_timeout/lock_timeout would abort
-- the lock wait or index build below and strand the migration in
-- P3018 manual recovery; this file prefers waiting over failing.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;

-- Serializes the dedup pass and the index build against concurrent
-- asset writes: EXCLUSIVE first waits out every in-flight asset write,
-- then queues new ones behind the migration, while still admitting
-- ACCESS SHARE so reads keep flowing. Without it a write committing
-- between the dedup and CREATE UNIQUE INDEX fails the whole deploy.
-- (CREATE INDEX itself only needs SHARE, which the held EXCLUSIVE
-- already covers against writers.)
LOCK TABLE "assets" IN EXCLUSIVE MODE;

-- Durable loser -> canonical map. It MUST survive a process death
-- after COMMIT: released rows lose the identity that defines their
-- duplicate group, so the pairing is unrecomputable afterwards — a
-- session temp table would strand every not-yet-retargeted binding
-- forever. The drain pass below deletes rows as their bindings finish
-- moving and drops the table once empty; after a crash, rerunning this
-- file (`migrate resolve --rolled-back`, redeploy) resumes from the
-- surviving rows. The ranked identity is stored alongside so a rerun
-- releases exactly the identity that was ranked and never one an
-- operator assigned in between. Deliberately no FK on loser_id: an
-- operator may purge a released asset while the table still lingers.
CREATE TABLE IF NOT EXISTS "migration_0062_asset_identity_retarget" (
  "loser_id"        uuid PRIMARY KEY,
  "canonical_id"    uuid NOT NULL,
  "external_id"     text NOT NULL,
  "external_source" text
);

-- Rank duplicate identity claims: prefer keeping the row a sync record
-- still owns, then an active row over an archived one, then the
-- oldest. Asset rows are frozen by the lock above, so the map cannot
-- go stale. On a rerun the ranking finds nothing (identities are
-- already released) and the surviving rows carry the pending work.
INSERT INTO "migration_0062_asset_identity_retarget"
  ("loser_id", "canonical_id", "external_id", "external_source")
SELECT "id", canonical_id, "external_id", "external_source"
FROM (
  SELECT claim."id",
         claim."external_id",
         claim."external_source",
         FIRST_VALUE(claim."id") OVER identity_claim AS canonical_id,
         ROW_NUMBER() OVER identity_claim AS position
  FROM "assets" AS claim
  LEFT JOIN (
    SELECT DISTINCT "asset_id"
    FROM "integration_sync_records"
    WHERE "asset_id" IS NOT NULL
  ) AS bound ON bound."asset_id" = claim."id"
  WHERE claim."external_id" IS NOT NULL
  WINDOW identity_claim AS (
    PARTITION BY claim."company_id", claim."external_source", claim."external_id"
    ORDER BY CASE WHEN bound."asset_id" IS NULL THEN 1 ELSE 0 END,
             CASE WHEN claim."archived_at" IS NULL THEN 0 ELSE 1 END,
             claim."created_at" ASC,
             claim."id" ASC
  )
) AS ranked_identity_claims
WHERE position > 1
ON CONFLICT ("loser_id") DO NOTHING;

-- First retarget pass: sync records bound to a losing row move to the
-- canonical row. A losing row that kept its records would read as a
-- manual asset whose next sync trips `assertExternalIdFree` against
-- the canonical row and sits in `blocked` forever. An asset carrying
-- several records — even from the same (mapping, resource) pair — is a
-- supported shape (multi-link assets, dossier bindingRef folds).
-- `SKIP LOCKED` keeps this pass out of lock cycles with an in-flight
-- sync transaction that already holds one of these record rows while
-- queueing behind the asset lock above (reconstruction page
-- transactions interleave record and asset writes in both orders, so
-- ANY waiting here can deadlock, and Postgres resolves such cycles by
-- aborting whichever side detects them — possibly this migration).
-- Skipped rows are converged by the drain pass after COMMIT.
UPDATE "integration_sync_records" AS record
SET "asset_id" = map."canonical_id"
FROM "migration_0062_asset_identity_retarget" AS map
WHERE map."loser_id" = record."asset_id"
  AND record."id" IN (
    SELECT contended."id"
    FROM "integration_sync_records" AS contended
    JOIN "migration_0062_asset_identity_retarget" AS contended_map
      ON contended_map."loser_id" = contended."asset_id"
    FOR UPDATE OF contended SKIP LOCKED
  );

-- Release identity on every losing row (contended-record losers too —
-- the index build below needs all duplicates gone). Guarded on the
-- ranked identity so a rerun after a post-COMMIT crash is a no-op and
-- can never wipe an identity assigned since. Released rows become
-- plain manual assets that keep their field values so an operator can
-- merge or purge them (see AssetsService.purge).
UPDATE "assets" AS asset
SET "external_id" = NULL,
    "external_source" = NULL
FROM "migration_0062_asset_identity_retarget" AS map
WHERE asset."id" = map."loser_id"
  AND asset."external_id" = map."external_id"
  AND asset."external_source" IS NOT DISTINCT FROM map."external_source";

-- Two partial indexes mirror the `assertExternalIdFree` comparison
-- exactly (archived rows included). A single unique index cannot cover
-- both shapes because Postgres treats NULLs as distinct: rows with a
-- NULL external_source must still be unique per (company_id,
-- external_id), so they get their own two-column index. Manual assets
-- (NULL external_id) stay outside both indexes. IF NOT EXISTS keeps
-- the file re-runnable after `migrate resolve --rolled-back`
-- (everything before COMMIT is atomic and needs no guard).
CREATE UNIQUE INDEX IF NOT EXISTS "assets_company_id_external_source_external_id_key"
  ON "assets" ("company_id", "external_source", "external_id")
  WHERE "external_id" IS NOT NULL AND "external_source" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "assets_company_id_external_id_no_source_key"
  ON "assets" ("company_id", "external_id")
  WHERE "external_id" IS NOT NULL AND "external_source" IS NULL;

COMMIT;

-- Short drain pass, outside the asset lock (writers are flowing again
-- and the indexes enforce). Records skipped above were held by
-- in-flight transactions; a few quick rounds catch the commit wave of
-- holders that finish right after the lock releases. SKIP LOCKED
-- still never waits, so this pass can neither deadlock nor stall the
-- deploy; it exits the moment the map is empty (the uncontended case
-- pays one round). Map rows are deleted as their bindings finish
-- moving and the table is dropped only when drained, so a crash at
-- any point resumes losslessly. This pass is deliberately SHORT: the
-- old worker keeps starting fresh page transactions until the new api
-- is healthy, so no finite wait here can guarantee convergence — the
-- unbounded tail belongs to `IdentityRetargetDrainService`, which
-- boots with the api seconds after this file finishes, drains the
-- surviving table rows in short row-lock-friendly rounds, and drops
-- the table when done. Until a straggler drains, its runs report
-- `blocked`; the count below lands in the server log.
DO $$
DECLARE
  pending integer := 0;
BEGIN
  FOR round IN 1..10 LOOP
    UPDATE "integration_sync_records" AS record
    SET "asset_id" = map."canonical_id"
    FROM "migration_0062_asset_identity_retarget" AS map
    WHERE map."loser_id" = record."asset_id"
      AND record."id" IN (
        SELECT contended."id"
        FROM "integration_sync_records" AS contended
        JOIN "migration_0062_asset_identity_retarget" AS contended_map
          ON contended_map."loser_id" = contended."asset_id"
        FOR UPDATE OF contended SKIP LOCKED
      );
    DELETE FROM "migration_0062_asset_identity_retarget" AS map
    WHERE NOT EXISTS (
      SELECT 1
      FROM "integration_sync_records" AS record
      WHERE record."asset_id" = map."loser_id"
    );
    SELECT count(*) INTO pending FROM "migration_0062_asset_identity_retarget";
    EXIT WHEN pending = 0;
    PERFORM pg_sleep(0.5);
  END LOOP;
  IF pending = 0 THEN
    EXECUTE 'DROP TABLE "migration_0062_asset_identity_retarget"';
  ELSE
    RAISE WARNING
      'weavestream 0062: % released duplicate asset(s) still have sync records bound; kept migration_0062_asset_identity_retarget — the api/worker background drain retargets them after boot (affected runs report blocked until then)',
      pending;
  END IF;
END $$;
