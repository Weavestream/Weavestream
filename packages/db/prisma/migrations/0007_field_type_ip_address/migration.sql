-- Extend the FieldType enum with IP_ADDRESS. This is an additive change
-- (no existing rows reference the new value), so it can run while the
-- app is serving traffic. The new value lands in the shared catalog as
-- a first-class field type and is the foundation the upcoming IPAM
-- feature will build on (discovery, subnet grouping, conflict checks).

ALTER TYPE "FieldType" ADD VALUE 'IP_ADDRESS';
