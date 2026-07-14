# Asset layouts

## Create and manage an asset layout
<!-- aliases: new layout | asset template | device template | server template | custom asset form | layout builder -->
<!-- requires: layout.manage.global -->

An asset layout is a global template shared by every company. It defines the fields and their order for one class of asset, such as Server, Workstation, Network device, Software license, or Certificate.

1. Open **Admin → Asset Layouts**.
2. Select **New layout**.
3. Choose a starter template or **Start from scratch**.
4. Set the layout name, slug, icon, and color, then select **Create & open builder**.
5. Add fields, set their options, arrange them, and select **Save layout**.

The layout becomes available in each company’s **New asset** layout picker. Layout fields are global, but the assets and their values are always company-scoped. The drag-and-drop builder is read-only on narrow screens; edit layouts from a wider viewport.

Use **Settings** in the builder to change the layout name, icon, or color. **Archive** removes a layout from new-asset pickers but preserves every existing asset. Open an archived layout and choose **Restore** to make it selectable again.

## Add and configure layout fields
<!-- aliases: add field | asset properties | custom asset field | field label | field slug | required asset field | unique asset field -->
<!-- requires: layout.manage.global -->

In **Admin → Asset Layouts**, open a layout and add a field from the field palette. Each field needs a human-facing name and a stable lowercase `snake_case` slug. A slug starts with a letter, is unique within its layout, and is the durable key for saved values, asset filtering, and integrations; rename the displayed name freely, but avoid changing a slug after importing or integrating data.

Each saved layout must contain 1–100 fields and exactly one **Primary** field. Existing field types cannot be changed because stored values were validated for their original type. To replace a type, add a replacement field, migrate values, then remove the old field only after reviewing the affected-asset warning.

Common switches:

- **Required**: an asset cannot be saved without a valid value.
- **Primary**: exactly one per layout; it is the asset’s prominent label in lists and detail views.
- **Show in table**: adds the field as a column in layout asset tables. Rich text and File fields cannot be table columns.
- **Visible to clients**: allows the field value to be returned in the client portal. This is enforced server-side, not merely hidden in the browser.
- **Unique per company**: no two assets using this layout in the same company may store the same non-empty value. Use it for serial numbers, stable device IDs, inventory IDs, or hostnames only when duplicates are invalid.

Drag fields to control form and detail order. The builder also supports named sidebar sections for grouping long forms. Select **Save layout** after every change.

## Choose the correct field type
<!-- aliases: field types | text field | dropdown | asset reference | tags field | vault link | file field | ip address field -->
<!-- requires: layout.manage.global -->

Choose a field type based on the value’s structure and how it should behave:

| Field type | Use it for | Important behavior |
|---|---|---|
| **Text** | hostname, serial number, vendor, model, asset tag | One-line text; can filter and be a table column. |
| **Textarea** | short plain notes, instructions, location detail | Multi-line plain text; not a field-filter column. |
| **Rich text** | formatted runbooks or asset notes | Tiptap editor with blocks, images, and `@` links to assets/articles/passwords; not table-compatible. |
| **Number** | RAM, port count, seat count, cost-free numeric quantity | Numeric value; can filter and be a table column. |
| **Date** | purchase, renewal, warranty date | Date-only value; can be an expiry. |
| **Date-time** | event timestamp, contract end at a specific time | Date plus time; can be an expiry. |
| **Boolean** | managed, encrypted, active, under warranty | Yes/no switch; can filter and be a table column. |
| **Dropdown** | operating system, environment, lifecycle state | One controlled choice from configured choices. |
| **Multi-select** | capabilities, services, compliance classifications | Multiple configured choices; not a flat field filter. |
| **Email** | device contact or service owner address | Validated email; displayed as an email link. |
| **Phone** | support number or circuit contact | Phone-oriented text input. |
| **IP address** | IPv4/IPv6 host or subnet | Validated IP; participates in IPAM occupancy discovery. |
| **URL** | management portal, vendor page, support URL | Validated URL and clickable link. |
| **Asset** | primary user, parent device, related switch | Picks an asset from a target layout and creates a navigable relation. |
| **Vault link** | external Vaultwarden/Bitwarden item URL or identifier | A link field for an external vault; it does not import or reveal that vault’s secret. |
| **File** | manuals, exports, certificates, diagrams | Upload one or more authorized files directly on the asset. |
| **Tags** | flexible labels shared across assets and passwords | Select existing global tags or create tags inline; use for cross-layout grouping. |

## Configure field-specific options
<!-- aliases: expiry field | expiration tracking | dropdown choices | allow other | multiselect limit | ip version | CIDR | file upload limit | reference target -->
<!-- requires: layout.manage.global -->

Configure these options in the selected field’s inspector:

- **Date** and **Date-time**: turn on **Expiry tracking** to include values in **Admin → Expirations**. Optionally set **Warn within days** for that field. Use for warranty, license renewal, certificates, or contract deadlines.
- **Dropdown**: add at least one named choice. Each choice has a stable slug; change the label instead of deleting/recreating a choice when possible. Turn on **Allow Other** only when operators need a controlled free-text exception.
- **Multi-select**: add at least one choice and optionally set **Maximum selections**. Use maximums for bounded classifications, such as up to two redundancy roles.
- **IP address**: choose IPv4 only, IPv6 only, or either family. Turn on **Allow CIDR** only if a value may be a subnet such as `10.0.0.0/24`, rather than a host address.
- **Asset**: select the target asset layout, choose one or multiple targets, and optionally set the relation type. Use a singular reference for “Primary user” and a multiple reference for “Connected devices.” Only assets in the same company can be selected.
- **File**: optionally restrict accepted file types, set a per-file maximum (up to 1024 MB), and allow multiple files. The field maximum works in addition to the deployment’s overall upload limit.

Use an **Asset** reference when the relationship should be queryable and shown in **Linked items**. Use a URL when only an external destination is needed.

## Plan layouts for lists, search, portals, and integrations
<!-- aliases: asset layout best practices | table columns | asset filters | client portal asset fields | integration target fields -->
<!-- requires: layout.manage.global -->

Make the primary field a short, stable human identifier such as Hostname, Device name, or License name. Mark only a few compact fields as **Show in table**; wide notes and files belong on the detail page. Text, Number, Date, Date-time, Boolean, Dropdown, Email, Phone, IP address, and URL fields support per-field asset-list filters. Rich text, textarea, multi-select, references, files, vault links, and tags do not support that flat filter syntax.

For client users, only mark fields **Visible to clients** when their values are appropriate to disclose. The portal strips other layout fields from API results. For integrations, create target fields with stable slugs and compatible types before mapping a resource. A field marked **Unique per company** is often useful as a safe matching candidate when it stores a reliable external identifier.

Archive rather than delete a layout when it should no longer be used for new assets. Before removing a field that contains values, inspect the affected-asset warning: removal archives that field and makes its values unavailable in normal asset forms.
