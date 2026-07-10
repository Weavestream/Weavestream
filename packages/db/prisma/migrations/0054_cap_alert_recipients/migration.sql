-- WS-031 remediation: disable any pre-existing alert config whose
-- recipient list exceeds the recipient cap.
--
-- New writes are capped at validation (`recipientEmailsSchema`,
-- MAX_ALERT_RECIPIENTS = 100) and delivery is bounded at the send path
-- (`EmailService.send`). This migration handles rows that were saved
-- before the cap existed, or written directly to `recipient_emails`:
-- an oversized alert is an outbound-email amplifier, so we DISABLE it
-- (rather than silently truncate who it emails) and record the action
-- in the audit log so an operator can review and re-configure it.
--
-- The literal 100 below mirrors MAX_ALERT_RECIPIENTS in
-- packages/shared/src/schemas/alert.ts — keep them in sync if it changes.

-- 1) Trace: one audit row per config we are about to disable.
INSERT INTO "audit_log" (
    "id", "actor_id", "action", "entity_type", "entity_id",
    "company_id", "before", "after", "created_at"
)
SELECT
    gen_random_uuid(),
    NULL,
    'alert.update',
    'AlertConfig',
    "id",
    "company_id",
    jsonb_build_object(
        'enabled', true,
        'recipientCount', coalesce(array_length("recipient_emails", 1), 0)
    ),
    jsonb_build_object(
        'enabled', false,
        'reason', 'recipient count exceeds MAX_ALERT_RECIPIENTS (100); disabled by WS-031 remediation'
    ),
    now()
FROM "alert_config"
WHERE "enabled" = true
  AND "archived_at" IS NULL
  AND coalesce(array_length("recipient_emails", 1), 0) > 100;

-- 2) Disable the oversized configs. They drop out of the emitter cache
--    and the runner query automatically (both filter enabled = true).
UPDATE "alert_config"
SET "enabled" = false,
    "updated_at" = now()
WHERE "enabled" = true
  AND "archived_at" IS NULL
  AND coalesce(array_length("recipient_emails", 1), 0) > 100;
