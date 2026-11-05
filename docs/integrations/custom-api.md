---
label: Custom API
icon: plug
description: Read records from any JSON-over-HTTPS API that has no built-in integration. You describe the API in a form; Weavestream syncs its records into the asset layout you pick.
---

# Custom API Integration

**Custom API** reads records from a JSON API that has no built-in Weavestream integration: a homegrown app, a small RMM, an internal CMDB, the users of a mail server. You describe the API in a form: how to sign in, where the organizations are, where the records are, how pages work, and which path in each record holds each field. Weavestream then syncs those records like every other integration: company mapping, field mappings, priority, schedule, runs, and the read-only section on the asset page.

The driver is **read-only** and **pull only**. Weavestream calls the API; the API never holds a Weavestream key.

## Overview & Features

- **One resource, any kind of record**: **Items** are the records the API lists: devices, users, licenses, or anything else. You pick the asset layout they go into and map each field on the **Items fields** tab. One integration fills one layout; a second kind of record needs a second Custom API integration.
- **Test as you go**: each section has a **Test** button. It reads the first page and shows the parsed records, the value each path found, and the keys of the first record. Click a key to put its path in the path input you selected last.
- **Import and export**: a definition can be exported as JSON and imported on another instance. The file never holds a secret.
- **Open in link**: an optional link template opens each record in the source app.
- **Secrets stay write-only**: credentials are stored encrypted and are never shown again, logged, or exported.

## Setup

1. Open **Admin → Integrations** and select **New integration**.
2. In **Driver**, pick **Custom API**. Enter a **Display name**, the **Base URL**, and the **Method** of authentication, then its credentials.
3. Select **Create integration**. The integration starts paused, with one organization ("All records") and **Items** turned off.
4. On **Credentials & schedule**, complete the **API definition**: **Organizations**, then **Items**. Select **Test** in each section.
5. Select **Save changes**. **Test connection** checks the saved definition, so it is off while the form has unsaved changes.
6. On **Organizations**, map each organization to a company.
7. On **Items fields**, turn on **Sync this resource on every run**, pick the **Target asset layout**, map each field to a layout field, and set the match keys.
8. Select **Dry run**, then **Run sync now**. Set **Status** to Active for scheduled syncs.

To start from a file, select **Import definition…** in the create dialog (or **Import definition** on the Credentials tab). The browser checks the file and lists each problem with its path. Nothing is saved until you select **Create integration** or **Save changes**. In the create dialog, an imported definition can be tested with the credentials you typed before you create it.

## The API definition

### Connection

| Field | Rules |
|---|---|
| **Base URL** | HTTPS. No user name, password, query string, or fragment. A path prefix is allowed (`https://inventory.example.com/api`). Every request path is joined to it, and no request can leave its host or path prefix. |

An API on a private network needs its range in `EGRESS_ALLOWED_PRIVATE_CIDRS`. Plain HTTP is not supported.

### Authentication

| Method | Fields | Credentials | What is sent |
|---|---|---|---|
| **Bearer token** | — | Token | `Authorization: Bearer <token>` |
| **API key header** | Header name | Header value | `<header name>: <value>` |
| **User name and password** | User name | Password | `Authorization: Basic …` |
| **OAuth client credentials** | Token URL, Scope (optional), how to send the client credentials | Client ID, Client secret | `Authorization: Bearer <access token>` |
| **No authentication** | — | — | — |

- An API key in the query string is not supported, because query strings end up in proxy logs.
- The **Token URL** must be HTTPS. It can be on another host than the Base URL.
- The credentials are replaced as a whole: enter every value when you rotate them.
- **Changing the Base URL or the Token URL to another host needs the credentials again in the same save.** The saved credentials are never sent to a new host. A path change on the same host keeps them.
- With **No authentication**, the integration needs no credentials. Saving such a definition removes any saved credentials, and the integrations list shows **not needed**.

### Headers

Up to 16 extra headers. Mark a header **Secret** to enter its value with the credentials; it is then stored encrypted and never exported. `Host`, `Content-Length`, `Cookie`, `Authorization`, `Proxy-*`, the header that the authentication method uses, and other transport headers cannot be set.

### Organizations

| Mode | How organizations are found |
|---|---|
| **From an endpoint** | A request lists the organizations. Set its **Records path**, **Id path** and **Name path**. Each resource request runs once per mapped organization and must contain `{orgId}`, or set the resource's **Organization id path**. |
| **From a field on each record** | Each record carries its organization id at the resource's **Organization id path** (and optionally a name). Weavestream reads all records once per run and gives each company its own. |
| **One organization** | All records belong to one organization, "All records". |

In endpoint mode, a resource with an **Organization id path** also drops any record whose organization is not the one being read. To test a resource in endpoint mode, pick an organization from the last Organizations Test, or type its id.

Changing the mode after mapping organizations changes the organization ids. Check the mappings on **Organizations** after you save.

### Requests

- **Method** is GET, or POST with a fixed JSON body.
- **Path** starts with `/`. Put query parameters in **Query parameters**, not in the path.
- Placeholders: `{orgId}` (endpoint mode), `{cursor}`, `{page}`, `{offset}`, `{limit}`. They go in path segments, query values, and string values of a POST body. Every value is URL-encoded.
- **Records path** is where the response holds the list. Leave it empty when the response itself is the list.

### Pagination

| Pages | Next page | Last page |
|---|---|---|
| **One request (no pages)** | — | Always |
| **Page number** | `{page}` + 1 (first page 1 or 0) | An empty page; with a total count path, all records read; otherwise a page shorter than **Page size** |
| **Record offset** | `{offset}` + records on this page | Same as page number |
| **Cursor from the response** | The value at **Cursor path** | A missing, null, or empty cursor |
| **Next page URL in the response** | The URL at **Next page URL path** | A missing or null URL |
| **Link header** | `rel="next"` in the `Link` header | No `next` link |

A next URL on another host or outside the Base URL path stops the run. A page, cursor, or URL that repeats stops the run with "The API returned the same page again". A cursor or next URL of the wrong type stops the run instead of ending it, so a broken response never marks assets stale.

### Paths

A path is dotted keys with optional indexes: `data.items`, `system.serial`, `addresses[0].value`, `["odd key"].value`. No wildcards or filters. A path that finds an object or a list gives no value and a Test warning.

### Items

| Field | Rules |
|---|---|
| **Id path**, **Name path** | Required |
| **Match value path** | Optional. The value that links an item to an asset you already have, such as a serial number or an email address. |
| **Fields** (up to 64) | Each has a **Key** (`agent_version`), a **Label**, a **Path**, and a **Type** (TEXT, NUMBER, BOOLEAN, DATE, DATETIME, URL, EMAIL, IP_ADDRESS). The keys `name` and `match_key` are used by Weavestream. |
| **Open in link** | Optional HTTPS template with `{id}` |

On **Items fields**, the source fields are **Name**, **Match key** (when a match value path is set), and each field. Map them to the fields of the layout you picked. Each field also shows in the **Custom API** section on the asset.

**Read items from this API** says whether the definition reads items. **Sync this resource on every run** on the **Items fields** tab still decides whether a run syncs them. When Items is turned off in the definition, a run skips it with a warning, and the existing assets are left as they are.

## Limits

| Item | Limit |
|---|---|
| Definition size | 64 KiB |
| Headers | 16 |
| Fields | 64 |
| Path length | 256 characters, 16 parts |
| Records per page | 10,000 |
| Records in memory (organization from a field) | 200,000 per resource |
| Synced text value | 1,000 characters |
| Test | 10 per minute; 5 records and the first record's keys; samples cut to 80 characters |

Test samples whose key or value looks like a secret are shown as `••••`. The raw response is never shown, logged, or stored.

## Example: a cursor API

```json
{
  "version": 1,
  "baseUrl": "https://inventory.example.com",
  "auth": { "method": "bearer" },
  "headers": [{ "name": "Accept", "value": "application/json" }],
  "organizations": {
    "mode": "endpoint",
    "request": { "method": "GET", "path": "/api/v1/groups" },
    "recordsPath": "groups",
    "idPath": "id",
    "namePath": "name",
    "pagination": { "style": "none" }
  },
  "resources": {
    "items": {
      "enabled": true,
      "request": { "method": "GET", "path": "/api/v1/devices", "query": { "group": "{orgId}", "cursor": "{cursor}" } },
      "recordsPath": "devices",
      "pagination": { "style": "cursor", "cursorPath": "nextCursor" },
      "idPath": "id",
      "namePath": "name",
      "matchPath": "system.serial",
      "fields": [
        { "key": "hostname", "label": "Hostname", "path": "hostname", "type": "TEXT" },
        { "key": "model", "label": "Model", "path": "system.model", "type": "TEXT" },
        { "key": "ip_address", "label": "IP address", "path": "system.privateIp", "type": "IP_ADDRESS" },
        { "key": "last_contact", "label": "Last contact", "path": "lastContactAt", "type": "DATETIME" }
      ],
      "recordUrl": "https://inventory.example.com/devices/{id}"
    }
  }
}
```

## Example: a page-number API with one organization

```json
{
  "version": 1,
  "baseUrl": "https://cmdb.example.org/api",
  "auth": { "method": "header", "headerName": "X-API-Key" },
  "organizations": { "mode": "single" },
  "resources": {
    "items": {
      "enabled": true,
      "request": { "method": "GET", "path": "/items", "query": { "page": "{page}", "per_page": "{limit}" } },
      "recordsPath": "data",
      "pagination": { "style": "page", "firstPage": 1, "pageSize": 100, "totalPath": "meta.total" },
      "idPath": "id",
      "namePath": "title",
      "matchPath": "assetTag",
      "fields": [
        { "key": "location", "label": "Location", "path": "location.name", "type": "TEXT" },
        { "key": "purchased", "label": "Purchased", "path": "purchaseDate", "type": "DATE" }
      ]
    }
  }
}
```

Both files hold no secrets. After an import, enter the token or header value yourself.
