-- Add optional DHCP scope (start/end of the dynamic range) to subnets.
ALTER TABLE "subnets"
  ADD COLUMN "dhcp_range_start" TEXT,
  ADD COLUMN "dhcp_range_end"   TEXT;
