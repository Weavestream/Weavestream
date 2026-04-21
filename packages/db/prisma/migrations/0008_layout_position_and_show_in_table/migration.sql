-- Company-scoped sidebar groundwork: give AssetLayout an explicit
-- ordering column so operators can group related categories in the
-- sidebar (Workstations / Servers / Network gear together, etc.),
-- and give AssetField an opt-in `show_in_table` flag that drives
-- per-layout asset table columns.
--
-- Both additions are backward-compatible:
--  * asset_layouts.position defaults to 0 → day-0 sort order falls
--    back to name alphabetical (tiebreak in the query), which is
--    what the UI was effectively doing already.
--  * asset_fields.show_in_table defaults to false → no existing
--    layout changes its rendered columns until an operator opts a
--    field in. The primary field is always shown by the renderer
--    regardless of this flag.

ALTER TABLE "asset_layouts"
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Supports the sidebar's `ORDER BY position ASC, name ASC` over active
-- layouts. Index is partial-friendly in practice (small table) so a
-- simple composite is sufficient.
CREATE INDEX "asset_layouts_is_active_archived_at_position_idx"
  ON "asset_layouts" ("is_active", "archived_at", "position");

ALTER TABLE "asset_fields"
  ADD COLUMN "show_in_table" BOOLEAN NOT NULL DEFAULT false;
