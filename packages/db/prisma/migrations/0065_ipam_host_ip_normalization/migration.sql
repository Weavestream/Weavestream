-- CR-018: canonicalize legacy IPv4 host spellings (leading-zero octets).
--
-- The API layer now canonicalizes host IPs (`normalizeIpv4V4`), but rows
-- written before that normalization can still hold equivalent spellings
-- ("010.0.0.5" vs "10.0.0.5"). Those aliases defeat the text-equality
-- lookups and unique keys the IPAM module relies on: duplicate
-- reservations for one host, inflated utilization counts, and false
-- canonical-field conflicts on shared integration targets.
--
-- Every value the application ever accepted matches the strict shape
-- below (four 1-3 digit octets, each 0-255, no mask suffix); values
-- outside it can only come from out-of-band writes. Like 0064, this
-- migration fails closed on such rows — but with an explicit message
-- instead of a cast error — so a deployment never silently carries
-- unparseable IPAM host values past the canonical checks installed here.

BEGIN;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;

-- Hold writers on both tables across validation, rewrite, and constraint
-- installation. Lock order mirrors the application's access pattern
-- (subnet before reservation) to avoid deadlocks.
LOCK TABLE "subnets" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "ip_reservations" IN SHARE ROW EXCLUSIVE MODE;

-- 1. Fail closed, with a diagnosis, on values the application could never
--    have written. The strict regex is cast-safe: anything it matches is
--    valid `inet` input, so the rewrites and checks below cannot abort
--    with an opaque cast error.
DO $$
DECLARE
  bad_reservations integer;
  bad_gateways integer;
  bad_dhcp integer;
BEGIN
  SELECT count(*) INTO bad_reservations
  FROM "ip_reservations"
  WHERE "ip_address" !~ '^(([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])$';

  SELECT count(*) INTO bad_gateways
  FROM "subnets"
  WHERE "gateway" IS NOT NULL
    AND "gateway" !~ '^(([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])$';

  SELECT count(*) INTO bad_dhcp
  FROM "subnets"
  WHERE ("dhcp_range_start" IS NOT NULL
    AND "dhcp_range_start" !~ '^(([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])$')
     OR ("dhcp_range_end" IS NOT NULL
    AND "dhcp_range_end" !~ '^(([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]{1,2}|[01][0-9]{2}|2[0-4][0-9]|25[0-5])$');

  IF bad_reservations > 0 OR bad_gateways > 0 OR bad_dhcp > 0 THEN
    RAISE EXCEPTION
      'CR-018 cannot canonicalize IPAM host values: % reservation IP(s), % gateway(s), % DHCP bound(s) are not plain IPv4 text; fix or clear these out-of-band values first',
      bad_reservations, bad_gateways, bad_dhcp;
  END IF;
END $$;

-- 2. Abort if canonicalization would collide two reservations inside one
--    subnet: the (subnet_id, ip_address) unique key cannot absorb the
--    rewrite, and which row survives is an operator decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ip_reservations"
    GROUP BY "subnet_id", host("ip_address"::inet)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'CR-018 cannot canonicalize reservation IPs: equivalent reservations exist within one subnet; delete or merge the duplicates first';
  END IF;
END $$;

-- 3. Rewrite alias spellings to the canonical dotted-decimal form.
UPDATE "ip_reservations"
SET "ip_address" = host("ip_address"::inet)
WHERE "ip_address" <> host("ip_address"::inet);

UPDATE "subnets"
SET "gateway" = COALESCE(host("gateway"::inet), "gateway"),
    "dhcp_range_start" = COALESCE(host("dhcp_range_start"::inet), "dhcp_range_start"),
    "dhcp_range_end" = COALESCE(host("dhcp_range_end"::inet), "dhcp_range_end")
WHERE "gateway" IS DISTINCT FROM host("gateway"::inet)
   OR "dhcp_range_start" IS DISTINCT FROM host("dhcp_range_start"::inet)
   OR "dhcp_range_end" IS DISTINCT FROM host("dhcp_range_end"::inet);

-- 4. Pin the canonical form as a database invariant (the 0064 stance for
--    `cidr`, applied to host columns): equivalent spellings become
--    unrepresentable, so the alias window cannot reopen through
--    out-of-band writers.
ALTER TABLE "ip_reservations"
  ADD CONSTRAINT "ip_reservations_ip_canonical_check"
    CHECK (
      family("ip_address"::inet) = 4
      AND "ip_address" = host("ip_address"::inet)
    );

ALTER TABLE "subnets"
  ADD CONSTRAINT "subnets_gateway_canonical_check"
    CHECK (
      "gateway" IS NULL
      OR (family("gateway"::inet) = 4 AND "gateway" = host("gateway"::inet))
    );

ALTER TABLE "subnets"
  ADD CONSTRAINT "subnets_dhcp_start_canonical_check"
    CHECK (
      "dhcp_range_start" IS NULL
      OR (family("dhcp_range_start"::inet) = 4
        AND "dhcp_range_start" = host("dhcp_range_start"::inet))
    );

ALTER TABLE "subnets"
  ADD CONSTRAINT "subnets_dhcp_end_canonical_check"
    CHECK (
      "dhcp_range_end" IS NULL
      OR (family("dhcp_range_end"::inet) = 4
        AND "dhcp_range_end" = host("dhcp_range_end"::inet))
    );

COMMIT;
