-- Sidebar item counts are now on by default for new users.
--
-- Users preferred to see the counts, so the column default changes from
-- false to true. Existing rows keep their stored value: a stored false
-- cannot tell a deliberate "off" from the old default, so this migration
-- does not overwrite it. Existing users turn the counts on under
-- Appearance in their profile.

ALTER TABLE "users"
  ALTER COLUMN "show_item_counts" SET DEFAULT true;
