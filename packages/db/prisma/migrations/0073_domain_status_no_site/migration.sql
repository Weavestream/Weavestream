-- Parked domains: registration fine, no A/AAAA record on the name.
ALTER TYPE "DomainStatus" ADD VALUE IF NOT EXISTS 'NO_SITE';
