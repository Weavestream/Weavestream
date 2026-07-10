---
label: Files & Photos
icon: file
order: 820
description: Per-tenant file uploads with image galleries and local storage.
---

# Files & Photos

Weavestream stores uploaded files on the local filesystem with one directory per tenant for storage-layer isolation. Images receive automatic thumbnail generation. A photo gallery view is available per tenant.

## Supported File Types

| Category | Types |
|---|---|
| Images | JPEG, PNG, GIF, WebP, HEIC |
| Documents | PDF, DOCX, XLSX |
| Email messages | MSG (Outlook) |
| Archives & installers | ZIP, 7Z, TAR, GZ/TGZ, MSI |
| Scripts | SH, PY — plus PS1, CMD, BAT, REG (uploaded as plain text) |
| Data & config | JSON, XML, YAML, CSV — plus INI, CONF (uploaded as plain text) |
| Text | TXT, MD, LOG, KEY, PEM |

The allowed MIME type list is configurable via `ALLOWED_UPLOAD_MIME` in `.env`. Browser-active content types — `text/html`, `application/xhtml+xml`, and XML-based image types such as `image/svg+xml` — are rejected at startup even if added to the list, because they can execute script when rendered inline.

## Storage Architecture

Each tenant has a dedicated directory under `${FILE_STORAGE_DIR}/<tenantId>/`:

```text
${FILE_STORAGE_DIR}/<tenantId>/uploads/<uploadId>/<filename>
${FILE_STORAGE_DIR}/<tenantId>/thumbs/<uploadId>.webp
${FILE_STORAGE_DIR}/<tenantId>/exports/<exportId>.pdf
```

- The api and worker share the same host-bind-mounted directory.
- Browsers never read the directory directly — every access streams through the API on the same origin as the web app, which authorizes the request against the requested tenant before opening the file.
- Writes are atomic (write to a temp sibling, then `rename`), so an `rsync` of the host directory while the stack is running never sees partial files.

## Image Processing

When an image is uploaded, the `worker` service:

1. Generates a thumbnail using **Sharp (libvips)**
2. Stores image dimensions (width × height) as metadata
3. Makes both the original and thumbnail available via stable, same-origin streaming URLs (`/uploads/:id/image` and `/uploads/:id/image?v=thumb`)

## Photo Gallery

Each tenant has a **Photo Gallery** view that displays all uploaded images in a grid layout with thumbnail previews. Click any image to view the full-size original.

## File Metadata

Each upload record stores:

| Field | Description |
|---|---|
| Original filename | As provided by the uploader |
| MIME type | Detected by `file-type` (with BOM pre-check for text files) |
| File size | In bytes |
| SHA-256 hash | Integrity verification |
| Dimensions | Width × height (images only) |
| `attachedToType` / `attachedToId` | Denormalised attachment target for filtering |

## Upload Limits

The maximum upload size is controlled by `MAX_UPLOAD_MB` in `.env` (default: 25 MB). The client-side mirror variable `NEXT_PUBLIC_MAX_UPLOAD_MB` should be kept in sync.

## Asset Field Attachments

The `FILE` field type on Asset Layouts allows attaching documents directly to asset records. Files attached this way appear inline on the asset detail page.

## Company Logos

Each company record can have one logo image. Logos are uploaded into the tenant's directory and displayed in the company list and sidebar.
