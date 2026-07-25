-- Per-user opt-in for the sidebar's item counts (assets per layout,
-- domains, passwords, subnets).
--
-- Default false, which is also what every existing row gets: the counts
-- are ambient density rather than something anyone navigates by, so the
-- product treats them as opt-in rather than opt-out. Users who want them
-- back turn them on under Appearance in their profile.
--
-- Deliberately narrow: this hides the neutral totals only. The
-- warning badges alongside them (expiring domains, stale passwords,
-- subnet conflicts) are anomaly signals and stay visible regardless —
-- a density preference must never be able to bury one.

ALTER TABLE "users"
  ADD COLUMN "show_item_counts" BOOLEAN NOT NULL DEFAULT false;
