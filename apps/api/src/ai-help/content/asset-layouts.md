# Asset layouts

## Create an asset layout
<!-- aliases: new layout | asset template | server template | device template | custom asset form -->
<!-- requires: layout.manage.global -->

Asset layouts are global templates shared by every company.

1. Open **Admin → Asset Layouts**.
2. Select **New layout**.
3. Choose a starter template or **Start from scratch**.
4. Enter the name, slug, icon, and color.
5. Select **Create & open builder**.
6. Add or adjust the fields in the layout builder, then select **Save layout**.

The new active layout appears in the layout picker when users create assets. The drag-and-drop builder is read-only on narrow mobile screens and should be edited from a larger viewport.

## Add and arrange layout fields
<!-- aliases: add field | custom field | layout builder | reorder fields | drag fields | asset properties -->
<!-- requires: layout.manage.global -->

1. Open **Admin → Asset Layouts** and select the layout.
2. In the builder, add the desired field type and give it a clear name and stable slug.
3. Configure whether the field is required, primary, shown in tables, visible to clients, or unique per company, where those options apply.
4. Configure field-specific options such as dropdown choices, expiry tracking, IP behavior, or reference targets.
5. Drag fields into the desired order and section.
6. Select **Save layout**.

At least one suitable field should be marked primary. Removing or changing fields already used by assets can be destructive; review the affected-asset warning before confirming.

## Choose field visibility and table behavior
<!-- aliases: visible to clients | client portal field | show in table | primary field | required field | unique field -->
<!-- requires: layout.manage.global -->

- **Primary** identifies the field emphasized in asset lists and detail surfaces.
- **Show in table** adds a supported field to the asset list table.
- **Visible to clients** allows the field to appear in the client portal. Hidden field values are removed server-side for client users.
- **Required** prevents saving an asset without a valid value.
- **Unique per company** prevents two assets in the same company from using the same value for that field.
- Expiry tracking on date fields makes those values available to the expiration dashboard.

Select **Save layout** after changing these options.

## Rename, archive, or restore a layout
<!-- aliases: layout settings | change layout name | remove layout | disable layout | restore layout -->
<!-- requires: layout.manage.global -->

Open the layout builder and select **Settings** to change its name, icon, or color. Use **Archive** to remove the layout from new-asset pickers without deleting existing assets. Open the archived layout and select **Restore** to make it active again.

