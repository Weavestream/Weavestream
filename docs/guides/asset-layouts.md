---
label: Asset Layouts
icon: table
order: 900
description: Create and manage global asset layout templates for infrastructure tracking.
---

# Asset Layouts

Asset layouts are the templates that define the fields on your asset records. This guide walks through creating, configuring, and managing layouts.

## Creating a Layout

1. Navigate to **Admin → Layouts** (requires `SUPER_ADMIN` role)
2. Click **New Layout**
3. Enter a name (e.g. "Server", "Workstation", "Software License")
4. Click **Create**

The layout is now available to all tenants in the asset creation picker.

## Adding Fields

With the layout open in the builder:

1. Click **Add Field**
2. Choose a field type from the dropdown (see [Field Types](/features/assets/#field-types))
3. Enter a label (the name shown on the asset form)
4. Configure field-specific options (see below)
5. Click **Save**

Repeat for each field you want on the layout.

## Configuring Field Options

### For all fields

| Option | Description |
|---|---|
| **Label** | The display name for the field |
| **Primary** | Highlight this field in list and table views |
| **Show in table** | Whether this field appears as a column in the asset list |
| **Visible to clients** | Whether this field appears in the client portal |

### For `DATE` and `DATETIME` fields

| Option | Description |
|---|---|
| **Expiry tracking** | Enable to include this field in the expiration dashboard |

### For `DROPDOWN` fields

| Option | Description |
|---|---|
| **Options** | The list of selectable values |
| **Allow "Other…"** | Enable a free-text escape hatch for one-off values |

### For `MULTISELECT` fields

| Option | Description |
|---|---|
| **Options** | The list of selectable values (drag-and-drop to reorder) |

## Reordering Fields

Drag any field by its handle to change its position in the layout. The order in the builder matches the order shown on asset forms and detail pages.

## Sidebar Sections

Fields can be grouped into named sidebar sections with custom positioning. This is useful for long layouts where related fields should be visually grouped.

## Renaming a Layout

From the layout list:

1. Click the **⋯** menu next to the layout
2. Select **Rename**
3. Enter the new name and confirm

Existing assets are not affected — they continue to reference the layout by ID, and the new name appears on their detail pages immediately.

## Archiving a Layout

Archiving hides the layout from the asset creation picker while preserving all existing asset records.

1. Click the **⋯** menu next to the layout
2. Select **Archive**
3. If assets exist using this layout, a warning is shown. Confirm to proceed.

Archived layouts are viewable from the **Archived** tab. Existing assets that reference an archived layout remain fully accessible.

## Example Layouts

### Server

| Field | Type | Options |
|---|---|---|
| Hostname | TEXT | Primary |
| IP Address | IP_ADDRESS | Show in table |
| Operating System | DROPDOWN | Windows Server, Ubuntu, Debian, Rocky, … |
| CPU | TEXT | — |
| RAM (GB) | NUMBER | — |
| Warranty Expires | DATE | Expiry tracking enabled |
| Notes | RICH_TEXT | — |

### Software License

| Field | Type | Options |
|---|---|---|
| Product Name | TEXT | Primary |
| Vendor | TEXT | Show in table |
| Seat Count | NUMBER | — |
| License Key | TEXT | — |
| Renewal Date | DATE | Expiry tracking enabled |
| Purchase Order | TEXT | — |
| Notes | TEXTAREA | — |
