-- Backfill: link FILE-field uploads to their owning asset.
--
-- When an operator uploads a file via the asset create form before
-- saving the asset, the upload row is initialized with
-- attached_to_type='asset' and attached_to_id=null (because no asset
-- exists yet at upload time). The asset save then writes the
-- uploadId into asset_field_values.value, but the upload row never
-- gets patched, leaving the photos gallery unable to deep-link to
-- the source asset.
--
-- Going forward this is fixed inside the asset write transaction
-- (`assets.service.ts:linkFileFieldUploadsToAsset`). This migration
-- runs a one-time backfill to clean up any rows that were created
-- under the old behaviour.
--
-- Idempotent: the WHERE filters skip rows that already carry an
-- attached_to_id, and the unique (uploads.id) identity makes a
-- second run a no-op even if the data shape regresses.
--
-- Tenant safety: the join binds afv.company_id = u.company_id, so
-- there is no path for an entry referencing an upload from a
-- different company to claim it (cross-tenant rows would not match).

UPDATE uploads u
   SET attached_to_id = afv.asset_id
  FROM asset_field_values afv,
       jsonb_array_elements(afv.value) AS entry
 WHERE u.attached_to_type = 'asset'
   AND u.attached_to_id IS NULL
   AND u.deleted_at IS NULL
   AND afv.company_id = u.company_id
   AND jsonb_typeof(afv.value) = 'array'
   AND (entry ? 'uploadId')
   AND (entry->>'uploadId') ~ '^[0-9a-fA-F-]{36}$'
   AND (entry->>'uploadId')::uuid = u.id;
