-- IPAM: subnets + ip_reservations

CREATE TABLE "subnets" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "company_id"  UUID         NOT NULL,
    "name"        TEXT         NOT NULL,
    "cidr"        TEXT         NOT NULL,
    "prefix"      INTEGER      NOT NULL,
    "vlan_id"     INTEGER,
    "gateway"     TEXT,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ,
    "created_by"  UUID,
    "updated_by"  UUID,
    "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "subnets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ip_reservations" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "company_id"  UUID         NOT NULL,
    "subnet_id"   UUID         NOT NULL,
    "ip_address"  TEXT         NOT NULL,
    "label"       TEXT         NOT NULL,
    "notes"       TEXT,
    "created_by"  UUID,
    "updated_by"  UUID,
    "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "ip_reservations_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "subnets_company_id_archived_at_idx" ON "subnets" ("company_id", "archived_at");

-- Active-CIDR uniqueness per company (archived rows don't block re-creation)
CREATE UNIQUE INDEX "subnets_company_cidr_active" ON "subnets" ("company_id", "cidr") WHERE "archived_at" IS NULL;

CREATE INDEX "ip_reservations_company_id_subnet_id_idx" ON "ip_reservations" ("company_id", "subnet_id");
CREATE UNIQUE INDEX "ip_reservations_subnet_id_ip_address_key" ON "ip_reservations" ("subnet_id", "ip_address");

-- Foreign keys
ALTER TABLE "ip_reservations"
    ADD CONSTRAINT "ip_reservations_subnet_id_fkey"
    FOREIGN KEY ("subnet_id") REFERENCES "subnets" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
