-- The Cloudflare integration switched from Rules Lists (`/rules/lists`,
-- async bulk operations) to Zero Trust Gateway Lists (`/gateway/lists`,
-- synchronous PATCH). The Gateway endpoint settles within the API
-- request, so the `pending_operation_id` / `pending_pushed_at` columns
-- and the `cloudflare-bulk-op-finalize` worker queue are no longer
-- needed.

ALTER TABLE "cloudflare_ip_lists"
    DROP COLUMN IF EXISTS "pending_operation_id",
    DROP COLUMN IF EXISTS "pending_pushed_at";
