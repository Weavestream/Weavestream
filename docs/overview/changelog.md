---
label: Changelog
icon: versions
order: 600
description: Release notes for all Weavestream versions.
---

# Changelog

All notable changes to Weavestream are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

## [1.8.10] - 2026-06-30

### Added

- **Configurable LLM token budgets.** Admins can now tune the AI chat's maximum output tokens and context-window size under **Admin -> Settings -> AI**. The chat service uses those values to reserve reply space, trim older context predictably, and avoid sending prompts that exceed the configured model's limits.
- **AI article actions now include a short intent preview.** When chat is likely to propose creating or editing an article, the assistant first streams a brief user-facing summary of what it is about to draft. General questions skip the prelude and continue to answer directly.

### Changed

- **Chat composer layout refreshed.** The company/article context display and question/edit/create intent controls now live directly in the composer, with a taller input, clearer context pill, and cleaner action layout.
- **Article tool calls are stricter and more reliable.** Article create/update tools now use strict schemas, explicit null handling, and turn-bound context so apply/reject actions stay tied to the company and article scope that produced the proposal. The chat history also carries prior tool outcomes so follow-up turns do not blindly repeat already-applied actions.
- **Environment configuration is slimmer and better documented.** `.env.example` now focuses on the values most installs must set, while optional and advanced variables moved into the environment documentation. JWT, password, integration, and SMTP key IDs now default to `1`, reducing first-run boilerplate while keeping rotation explicit.
- **Company logos render more flexibly.** `CompanyAvatar` now supports wider custom logos in detail views while preserving the existing square avatar behavior in compact navigation and list contexts.

### Fixed

- **Explicit article saves now clear existing autosave drafts.** A manual Save, including an AI chat-apply save, now promotes and clears an in-progress autosave draft even when the submitted article body is identical to the live row.
- **Truncated or malformed AI article proposals are surfaced clearly.** Tool-call failures caused by model length limits, empty arguments, or malformed JSON now carry machine-readable error codes and show a softer warning in the UI instead of a generic hard failure.
- **File upload MIME inference is more consistent** across browser-supported upload types.

### Security

- **Sensitive admin actions now require step-up re-authentication.** Backup downloads, company exports, AI/email/integration settings changes, selected user administration actions, and security-session revocation routes now require a fresh session-bound confirmation before proceeding. MFA-enabled users confirm with TOTP or a backup code; other users confirm with their password. The confirmation window is Redis-backed, defaults to 15 minutes, is configurable with `STEP_UP_TTL_SEC`, and is cleared on logout/session revoke.
- **Refresh tokens now rotate on use.** Refresh tokens are single-use, with a 15-second grace window for benign concurrent browser requests. Reuse after that window revokes the session, clears any step-up window, and records an `auth.refresh.reused` audit event with only a short token-hash prefix for correlation.
- **Blocked egress logs now redact query strings.** `safeFetch` writes blocked outbound URLs through the shared redaction helper so audit logs keep host/path context without storing query parameters that may contain tokens or credentials.

## [1.8.9] - 2026-06-25

### Changed

- **New passwords now default to internal/private.** Both the "New password" dialog and the API now default new credentials to *not* visible in the client portal; sharing to the portal requires an explicit opt-in. Switching the toggle to "Visible" shows an inline warning that client portal users will be able to see and reveal the credential. Existing credentials are unchanged.
- **Password internal access now has a dedicated sidebar control.** Credential visibility in the client portal remains controlled by the existing "Visible to client portal users" checkbox, while internal per-user restrictions are managed from the password detail sidebar. The default remains all internal users; restricted credentials can now also be limited to super admins only.
- **pnpm 11 is now the workspace package manager.** `packageManager` in root `package.json` is pinned to the current exact pnpm 11 release (`pnpm@11.9.0`), CI runs the same version, and pnpm configuration now lives in `pnpm-workspace.yaml` using pnpm 11's `allowBuilds` map. Production containers continue to run prebuilt Node apps; pnpm is only used while installing and building images.

### Fixed

- **Starred items and Linked Items panels could silently load empty.** The browser-facing proxy relayed a stale `Content-Encoding: gzip` header on responses the runtime had already decompressed, so the browser failed to decode larger JSON payloads (`ERR_CONTENT_DECODING_FAILED`) and callers mis-rendered as empty. The proxy now drops the stale `Content-Encoding`/`Content-Length` headers.
- **Expired or missing sessions now redirect to the login page instead of erroring.** Auth-gated admin and portal pages previously could crash with a server error when a session was null; they now consistently route to `/login`.
- **Scheduled RMM integration syncs no longer fail in a retry loop on NUL bytes.** Upstream data from integrations (e.g. Action1, NinjaOne) containing a NUL byte (`U+0000`) was rejected by Postgres and retried indefinitely. Such bytes are now stripped from third-party data before it is persisted.
- **Removed a deprecation warning on API boot** by updating the `/health` route-prefix exclusion to the current Express 5 / Nest 11 wildcard syntax. The public, ready, and queue health endpoints resolve at the same paths as before.

### Security

- **Auth, CSRF, and UI cookies now set `Secure` based on the deployment URL scheme.** The `Secure` cookie attribute is derived from whether `APP_URL` is `https://` rather than from `NODE_ENV`, so HTTPS deployments always issue secure cookies and fail closed regardless of environment settings. Plain-HTTP local development is unaffected. A new startup warning flags a public HTTPS deployment running in a non-production environment.
- **Article version history is now gated per version's own client visibility.** Portal (client) users viewing an article's version history only see historical versions that were themselves marked client-visible at the time they were written, even if the article is currently client-visible. Hidden versions return 404 with no existence disclosure; operators still see full history.
- **Stronger server-side checks on upload confirmation and attachments.** Confirming a pending upload now re-verifies uploader ownership, and an upload's declared attachment parent (asset, article, asset field, or password) must exist, be in the same company, and — for passwords — be readable by the actor before the link is persisted. Password attachments are now governed by the same read policy as the password detail view.
- **Non-image uploads now download as attachments and are not browser-cached.** PDFs, Office docs, archives, scripts, and other non-image originals are served with `Content-Disposition: attachment` and `Cache-Control: private, no-store` so they download instead of rendering inline and are never written to the browser disk cache. Images still render inline. `X-Content-Type-Options: nosniff` is now set on the stream itself.
- **Password internal restrictions now apply consistently.** Internal users outside a credential's allow-list can no longer read its metadata, notes, versions, TOTP, reveal response, relations, expiration rows, or password-attached uploads. Super admins are always included in restricted credential access and are shown as non-removable entries in the picker.
- **Safer reverse-proxy topology is harder to misconfigure unnoticed.** Startup now emits a log-only warning when `APP_URL` points at a public host over plain HTTP or with collapsed proxy trust (`TRUST_PROXY_HOPS=0`), and the Compose file, `.env.example`, and deployment docs now call out that exposing the web port directly is for local/LAN use only, with a verification recipe for confirming a forged `X-Forwarded-For` is ignored. No IP-trust behavior or defaults changed.
- **Documented dependency patch SLA.** `SECURITY.md` now records target times from a confirmed dependency advisory to a tagged patch release (Critical 72h, High 7d, Moderate 30d, Low next cycle) alongside the existing CI `pnpm audit` gate and grouped Dependabot updates.

## [1.8.8] - 2026-05-22

### Changed

- **Admins can now preview the client portal.** Operators with admin-shell access (SUPER_ADMIN, or OPERATOR with non-NONE `globalAccess` / platform capabilities) who don't hold a membership on a company can now load `/portal/<slug>` and walk the portal in the exact shape a client would see it, instead of being bounced to `/admin/companies`. Read-only by design — no edit affordances are surfaced under preview, and every per-company data fetch still runs through the same `RequirePermission` checks at the API.

### Fixed

- **Operator home "Starred" panel was empty on mobile.** The panel body collapsed to zero pixels on phone-width layouts because it relied on the desktop grid's equal-row stretch for height. The body now reserves a minimum height when the list is non-empty so starred items render on every viewport.

## [1.8.7] - 2026-05-21

### Changed

- **IP rules now block page renders, not just API calls.** A DENY rule for a given IP/CIDR returns `403 Access denied by IP rule` for both API requests (immediate) and Next.js HTML pages (within ~30 s, the page-layer cache refresh window). A blocked IP no longer sees a login form. Static asset paths under `/_next/*` remain reachable by design.
- **Self-block guard on IP rule changes.** Creating, editing, or deleting an IP rule in `/admin/ip-rules` is refused with a 400 if the resulting ruleset would block the requesting admin's current IP. The error names the offending CIDR. To deliberately block your own range, add a higher-priority ALLOW for your specific IP first.

### Fixed

- **Failed logins are now recorded regardless of password length.** Wrong-password attempts with a password shorter than 8 characters used to short-circuit at the request validator before the auth service ran, so the security center showed no failure even though the operator had clearly typed a bad password. Removing the login-side length check makes every credential attempt flow through the lockout counters and the audit trail. A consequence is that a locked IP now returns `429 Too many failed attempts` consistently for any payload, instead of leaking lockout state via a 400-vs-429 split.

### Security

- **SSRF guard hardening (`safe-fetch.ts`).** AI / chat endpoints (`AiService.listModels`, the chat-completion stream, the title-generation post-call) now route through `safeFetch` with `allowPrivateNetworks: true` so LAN LLMs (LM Studio, on-prem Ollama) work out of the box while every other egress surface keeps the private-IP block. The `redirect: 'follow'` loophole is closed in-process — every 3xx hop re-resolves and re-validates against the block-list, capped at 5 hops. DNS rebinding is closed by pinning each fetch's TCP connect to the IP that was validated, while preserving SNI + `Host` for certificate verification. The alerts HTTP probe drops `redirect: 'follow'` and uses a manual follow loop. Tests added for all three windows.
- **Egress exception for the AI base URL.** The URL pasted in **Settings → AI** is now treated as authorised regardless of address class, so LAN LLM endpoints don't require operator-level `EGRESS_ALLOWED_PRIVATE_CIDRS` configuration. The exception is scoped per call site (visible in `git grep allowPrivateNetworks`); every other admin-configurable URL keeps the existing private-IP block.
- **Upload reads gated by parent visibility for CLIENT_USER.** Portal users can no longer fetch an upload by id when its parent record (asset / article / company) is not visible to them, even if the upload id is known.
- **Recovery documentation for self-imposed IP blocks.** `docs/configuration/security.md` adds a "Recovering from a self-imposed IP block" section with concrete shell + SQL recipes for the three escape paths (connect from a different network, curl the API on `localhost` from the host, modify the database directly).

## [1.8.6] - 2026-05-20

### Changed

- **IPAM address space grid** styling refreshed for clearer subnet layout at a glance.
- **Password reveal "auto hide" control** keeps its label and icon on one row when space is tight.
- **Password detail "embedded on asset" pill** spacing tightened so the label reads cleanly on narrow layouts.

### Fixed

- **Cloudflare integration IP entries** now accept IPv6 CIDR prefixes (e.g. `2601:280:5280:7bc0::/64`). Validation covers all standard zero-compression forms with prefix lengths 0–128; the entry dialog help text and error message include an IPv6 example.

## [1.8.5] - 2026-05-18

### Added

- **Article version history.** Every explicit Save creates a numbered version. A new History panel on each article lists past versions (newest first, changed-field chips, author + timestamp), opens a preview drawer for any version's body, and Restores it as a new forward-only version. Archiving an article auto-discards in-progress drafts; permanently deleting an article cascade-deletes its history rows.
- **Opt-in article autosave drafts.** Autosave is now off by default and gated by a workspace-wide toggle in **Admin → Settings → Articles**. When enabled, autosaves write to a separate draft row rather than the live article body; Cancel discards the draft and reverts the article to its last published version.
- **Workspace default article editor.** New "Default editor format" picker (WYSIWYG / Markdown) under **Admin → Settings → Articles** seeds the format for new articles. Existing articles continue to open in whatever mode they were saved in.
- **Archive / restore / permanently delete articles from the UI.** Archive and Restore buttons appear on the article read page, edit page, and inline on each list row. A separate **Delete forever** action — gated on the article being archived first and on the operator typing the article title — cascades the article and its history. Backed by a new `article.purge` FULL-membership permission.
- **Clickable `@`-mentions** in articles and rich-text asset fields. Mentions render as anchor pills that navigate to the referenced article / asset / password; admin vs portal routing is chosen from the viewer's memberships and unauthorised destinations still 404 / 403 at the API.
- **Photos gallery link states.** Every photo now carries one of four states — `Live`, `Versioned`, `Archived`, or `Orphan` — surfaced as tags on each tile, with a "Show orphaned & archived" toggle (default off). Orphan and archived tiles get a delete chip that tombstones the upload after a confirmation; live and versioned images are blocked from deletion to keep embedded content intact. Article-attached images also expose an "open source article" deep link.
- **Refreshed dashboard "At a glance" panel.** Six tiles (Companies, Users, Assets, Passwords, Articles, Domains) sourced from a dedicated `/admin/stats` endpoint replace the previous five-tile mix.
- **Notes side panel.** Per-company sticky notes moved out of the header into a dedicated side panel.

### Changed

- **Action buttons unified into page headers.** Domains, IPAM, Passwords "New" actions and article / asset builder Save / Cancel actions now live in the page header alongside the breadcrumbs.
- **Top header for global actions.** Expirations, Starred, Chat, and Profile entries moved out of the sidebar into the top header.
- **Passwords on the company dashboard.** The "Photos" card on the per-company dashboard has been replaced with a Passwords summary card.
- **Recent activity panel surfaces created vs updated** on the admin dashboard.
- **Recent companies and starred items capped at 10** with an internal scroll container.
- **All-assets search box.** Dropped the inline record count and refreshed the layout-filter dropdown styling.
- **Section icons** added to Articles, Photos, Domains, IPAM, and Passwords list pages.
- **Folder browser.** The `+` action only appears on hover, and the "Edit" button was renamed to "Edit Folder".
- **Subtler hover affordance** on clickable cards.
- **Pills.** Dropped the leading dot from pill chips across the platform.
- **Asset layout description copy** refreshed for consistency.
- **AI prompt clarity.** Further tweaks to LLM prompts for better context handling and article-drafting accuracy.

### Fixed

- **Asset FILE-field uploads lost their owning-asset back-link** when uploaded from the new-asset form (the dropzone fires before the asset exists). The owning asset is now stamped onto the upload inside the same transaction as the field-value write; a one-time migration repairs rows created under the old behaviour.
- **Permanent article delete left orphan images** in the photos gallery when those images were embedded only in older versions. Purge now unions the live body with every non-draft version body and tombstones every upload referenced by any of them.
- **Restoring a previous article version no longer soft-deletes images** that the older version (or any other historical version) still embeds.
- **Discard draft and autosave coalesce paths could 500** because the version-row writes were missing a tenant filter the database middleware could enforce. Fixed so every history-row write carries an explicit company filter.
- **Rich text fields beyond the first** rendered inline on the asset detail page instead of in their own panels. All rich-text fields now render as separate panels below the top panel.
- **Article editor action buttons** were sharing a row with the breadcrumbs in some layouts; moved into a dedicated row below.
- **Alert config picker showed a UUID** instead of the company name when editing a company-scoped alert.
- **Article excerpt previews leaked embedded image filenames** in the preview text; filenames are now stripped.
- **Duplicate asset titles** on the asset detail page have been removed.
- **History-panel Restore confirmation** sat behind the drawer overlay; dialog and toast layering was adjusted so confirms always render above the sheet that launched them.

### Security

- **Tenant-scoped history writes.** Article version draft / discard / restore / archive paths now route through multi-row writes with explicit `{ id, companyId }` filters so the database tenant middleware enforces isolation on every history-row write.
- **TOCTOU re-check on photo delete.** The photos delete endpoint re-runs the link-state classifier at the moment of deletion and rejects `live` / `versioned` uploads even if the UI affordance was stale.
- **`article.purge` permission gating.** New FULL-membership-only permission; archive-before-purge is enforced server-side and the type-the-title client-side defends against accidental and tool-call-driven deletes. Every purge is audited with the version count and the upload tombstone count.
- **NinjaOne `htmlToPlain` hardened against nested-tag bypass.** The HTML-to-plain-text helper now strips tags in a fixed-point loop so nested or overlapping patterns (e.g. `<scr<script>ipt>`) can't survive sanitisation.
- **Photos source-article lookup respects client visibility.** The new source-article resolver scans only active articles and applies the client-visibility filter for portal users; upload ids are pre-validated as canonical UUIDs before being inlined into the regex alternation.

## [1.8.4] - 2026-05-16

### Added

- **DHCP scope in IPAM.** Subnets can now record a DHCP scope (start / end range) alongside their CIDR, so the IPAM view can distinguish DHCP-assigned ranges from statically-reserved space at a glance.
- **Ticket browser.** New read-only ticket browser for searching and filtering tickets across the platform. Tickets can be handed to the AI chat to turn the resolution into a new article in one step.

## [1.8.3] - 2026-05-13

### Fixed

- **Markdown image picker scrolling.** The image picker dialog in the Markdown editor now allows scrolling when content exceeds screen height.

### Changed

- **AI prompt clarity.** Tweaked LLM prompts with clearer instructions for better context handling.
- **Mobile credential dialog layout.** The new credential dialog was exceeding screen height on mobile; adjusted to fit within viewport.
- **Dashboard mobile layout.** Moved dashboard's "at a glance" items into columns for better mobile viewing.

## [1.8.1] - 2026-05-13

### Added

- **Markdown article editor — image picker.** When editing an article as Markdown, **Insert image** opens a dialog with three tabs: upload a new image (drag-and-drop or file chooser), pick from images already referenced in the current draft, or browse the company’s article-attached image library with filename search and pagination. Inserted images use stable same-origin URLs so they survive saves and match the Markdown ↔ rich-text conversion pipeline.

### Changed

- **Domain hygiene checks and scoring.** Updates to monitored-domain checks and to how the hygiene score is computed and shown on domain detail and history views — clearer signals and more dependable results across DNS, TLS, email authentication, and HTTP checks.

## [1.8.0] - 2026-05-12

### Added

- **AI chat.** A new AI chat panel is available on every company page (toggle in the sidebar). Conversations are persisted as chat history. The AI is powered by any OpenAI-compatible LLM — configure the endpoint, model, and API key under **Admin → Settings → AI**. Chat supports multi-turn conversations with full history review and the ability to start fresh conversations at any time.

- **Chat context — articles & assets.** Attach articles and assets to a chat conversation via `@`-mention. The currently viewed asset or article is automatically attached to the chat context when the panel is opened. Attached items appear in a context strip above the input field. A collapsible folder navigation panel inside chat lets you browse and attach items without leaving the conversation.

- **AI article editing.** The AI can read and edit articles on your behalf via tool calls. When viewing an article, the AI has write access to the open document — accepted edits are applied directly. Chat responses can also be saved as new articles via a "Save as article" action.

- **Passwords in Expirations.** Password expiry dates now surface alongside certificates and assets in the **Expirations** view, so upcoming credential renewals appear in the same dashboard as other lifecycle events.

- **Password folder rename & archive.** Password folders can be renamed and archived from a new folder settings dialog, keeping the credential vault tidy as structures evolve.

- **Password linking.** Passwords can be linked to articles and assets using the existing relations system. Linked items and file attachments are accessible directly from the password detail panel — consistent with how assets and articles handle relations.

- **Redesigned password dialog.** The create / edit password dialog has been refreshed: tags are now managed with an inline tag-input chip component, the URL field has moved below the password field, and the overall layout is more consistent with asset and article forms.

- **`.pem` file uploads.** `.pem` certificate files can now be attached as file uploads, extending the `.key` support shipped in 1.7.1.

### Security

- **`crypto.getRandomValues` replaces `Math.random`.** All internal ID / token generation now uses the cryptographically-secure `crypto.getRandomValues` API instead of `Math.random`.

### Fixed

- Fixed a bug where creating a new article via chat could fail due to an incorrect regular expression.
- Fixed a remote property injection bug in the assets controller.

## [1.7.1] - 2026-05-08

### Added

- **NinjaOne agent / non-agent split.** The NinjaOne integration now exposes two independent resources: **Agent devices** (workstations and servers running the NinjaOne agent) and **Network & non-agent devices** (NMS-discovered switches / firewalls / printers, plus VMware / Hyper-V / Xen guest VMs and hypervisor management nodes). Each resource projects onto its own asset layout, has its own match key, and runs as a separate sync job — so MSPs can keep agented endpoints in their primary computers layout while routing SNMP gear and virtual machines into a dedicated network or VM layout, or skip the non-agent devices entirely. The new resource is optional and disabled until an operator picks a layout and configures field mappings. Default match-key suggestion changed from `systemName` to **`uid`** (NinjaOne's stable GUID) on both resources to avoid the IP / hostname churn issues that plagued IP-keyed mappings.
- **`.key` file uploads.** Plain-text key files (PEM, SSH, certificate keys) can now be attached as file uploads alongside the existing image / document / archive / script / config types.

## [1.7.0] - 2026-05-07

### Added

- **NinjaOne RMM integration.** New integration driver for syncing managed devices from NinjaOne organisations into Weavestream asset records, joining the existing Action1, UniFi, and Cloudflare drivers under **Admin → Integrations**. Authentication is OAuth2 `client_credentials` with the `monitoring` scope; the regional API base URL is configurable for US / EU / CA / OC tenants. Each NinjaOne organisation maps to a single Weavestream company, with an optional per-mapping location-ID filter.
- **Rich NinjaOne field catalogue.** The driver flattens the `/v2/devices-detailed` payload — `os`, `system`, `memory`, `processors[0]`, `volumes[0]`, `references.*` (organisation, location, role, policy, role-policy, warranty, assigned owner) and `maintenance` subtrees — onto roughly seventy mappable top-level fields covering identity, OS, make / model / serial / BIOS, processor, memory, volumes, network, warranty, owner, role, policy, location, lifecycle, and maintenance state.
- **Human-readable variants for byte and clock-speed fields.** `memoryCapacityHuman`, `systemTotalPhysicalMemoryHuman`, `firstVolumeCapacityHuman`, `firstVolumeFreeSpaceHuman`, `processorClockSpeedHuman`, `processorMaxClockSpeedHuman` render alongside the raw numeric fields, formatted like `127.5 GB` / `4.4 TB` / `2.10 GHz` for direct mapping onto TEXT and rich-text AssetFields.
- **Multi-line `volumesSummary`.** TEXTAREA-typed field that renders every volume on the device as one line each — `<name>[ <label>] — <capacity> total, <freeSpace> free (<filesystem>)` — for asset layouts with a single storage textarea slot.
- **Primary IP and MAC derivation.** `primaryIpAddress` (IP_ADDRESS) and `primaryMacAddress` (TEXT) are derived from NinjaOne's array-valued `ipAddresses` / `macAddresses` so single-value asset fields can be mapped directly. The IP heuristic splits the IPv6 GUA + link-local pairs NinjaOne packs into one slot, then prefers non-link-local IPv4, falling back to non-link-local IPv6 and finally the first entry.

### Documentation

- **Integrations page refreshed** to include the new NinjaOne section alongside Action1, UniFi, and Cloudflare, with a category-grouped list of synced data and a step-by-step setup walk-through.

## [1.6.4] - 2026-05-06

### Added

- **Cloudflare integration.** New integration driver for updating Cloudflare Zero Trust IP lists. Manage Cloudflare Zero Trust IP lists directly from Weavestream via API token authentication. Managed under **Admin → Integrations** alongside existing Action1 and UniFi connectors.

---

## [1.6.3] - 2026-05-03

### Added

- **Password list columns.** Toggle to show or hide strength and visibility columns on password tables.
- **UniFi clients.** UniFi integration now includes client devices alongside existing synced data.
- **Bulk asset actions.** Bulk archive, delete, and restore from all-assets views.
- **Company sticky note.** Per-company sticky note in the admin company shell for quick operator notes.

---

## [1.6.2] - 2026-05-01

### Changed

- **Backup job reliability tweaks.** Scheduled and manual Postgres export jobs now handle edge cases more consistently across retention, history, and download workflows.

### Fixed

- **Vault PDF exports.** Fixed PDF generation issues in vault exports that could produce broken or incomplete documents.
- **Password detail mobile layout.** Fixed mobile rendering of password detail views so content and actions remain readable on narrow screens.

## [1.6.0] - 2026-05-01

### Added

- **In-app scheduled Postgres exports.** Operators with the new `BACKUP_MANAGE` capability (or `SUPER_ADMIN`) can configure cron schedules under **Admin → Backups** that produce `pg_dump --format=custom` files plus a `manifest.json` sidecar in a new bind-mounted host directory (`${DATA_DIR}/backup`). Schedules carry a timezone, GFS retention (`{ daily, weekly, monthly }`), and optional notification recipients (failures always email; successes are opt-in). Manual "Run now" attempts are polled to terminal status in the History tab; successful runs surface a download button that streams the dump back through the API. Concurrency is guarded by a Postgres advisory lock around the whole job. The worker image now ships `postgresql16-client` so `pg_dump` is available without sidecars.

### Documentation

- **Backup & Restore guide refreshed** to cover the new in-app scheduled exports, the off-host sync of `${DATA_DIR}/backup` and `${DATA_DIR}/files`, and a step-by-step `pg_restore` recovery on a fresh Docker host. The authentication page now flags that vault decryption requires the matching `.env` keys at restore time.

## [1.5.6] - 2026-04-30

### Changed

- **MinIO replaced with native local filesystem storage.** The `minio` container is gone. The api and worker now share a host-bind-mounted directory (`${DATA_DIR}/files`, surfaced inside the containers as `${FILE_STORAGE_DIR}`, default `/var/lib/weavestream/files`) and write atomically via tmp+rename. Per-tenant isolation is by directory (`${FILE_STORAGE_DIR}/<companyId>/...`); browsers continue to read every file through the API's same-origin streaming endpoints, so there is still no public file surface. The AWS S3 SDK is no longer a runtime dependency.

### Removed

- **MinIO service** from `compose.yml`, the `compose.console.yml` overlay, and the `minio:` block in `compose.build.yml`.
- **All `MINIO_*` env vars** (`MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `MINIO_REGION`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET_PREFIX`, `MINIO_PUBLIC_URL`, `NEXT_PUBLIC_MINIO_ORIGINS`).
- **AWS S3 SDK runtime dependencies** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).

## [1.5.5] - 2026-04-30

### Changed

- **MinIO configuration simplified.** The upload client now fetches MinIO config directly from the API, removing the need for a reverse proxy setup.

### Fixed

- Miscellaneous bug fixes.

## [1.5.4] - 2026-04-30

### Security

- **Audit log is now append-only at the database layer.** A new Postgres trigger blocks any `UPDATE` or `DELETE` against `audit_log` with the error `audit_log is append-only`, raising tamper-resistance from an application convention to a database invariant. `INSERT` is the only legal write, and `pg_dump` / `pg_restore` are unaffected. Operators who genuinely need to rewrite audit rows (for example to anonymise a dump) can disable the trigger as the table owner; see the [Audit Log docs](/security/audit-log/#tamper-protection).
- **Containers can no longer escalate privileges at runtime.** Every service in `compose.yml` (`postgres`, `redis`, `minio`, `api`, `worker`, `web`) now boots with `no-new-privileges:true`, so a process inside the container can't gain new Linux capabilities via a `setuid` binary even if a vulnerability lets it execute one. Transparent for operators — no `.env` or workflow changes required.
- **MinIO image pinned to a specific release.** `compose.yml` now references `minio/minio:RELEASE.2025-09-07T16-13-09Z` instead of `:latest`. This is the same image `:latest` resolves to today, so existing deployments are neither upgraded nor downgraded — but future `:latest` drift can no longer silently change the image under a running install. Upstream archived the public `minio/minio` Docker repository, so a deliberate migration to a maintained successor is tracked as its own future release.

## [1.5.3] - 2026-04-29

### Added

- **MFA backup codes.** Completing MFA enrollment now issues one-time recovery codes that users can save, copy, and use on the MFA challenge if their authenticator is unavailable. Codes are hashed at rest, consumed atomically, deleted when MFA is reset, and can be regenerated from the profile page. Operators also get `reset-mfa <email>` in the CLI to clear MFA, backup codes, and active sessions for account recovery.

### Changed

- **Uploads relayed through the API.** Browsers no longer PUT directly to MinIO; the init endpoint now returns a same-origin relay URL (`/api/v1/companies/:id/uploads/:uploadId/blob`) and the API streams the body to the internal bucket. Embedded article images served via `/uploads/:id/image` are likewise streamed back through the API instead of 302-redirecting to a presigned S3 URL. This keeps MinIO fully reachable only over the Docker network (matching the v1.5.2 loopback-by-default `MINIO_HOST_BIND`) and removes the need to put a reverse proxy in front of the bucket endpoint just so a browser can upload a logo or paste an image into the rich-text editor.

### Security

- **MFA reset hardening.** Admin-triggered MFA resets now require a recent actor sign-in, clear stored backup codes, and revoke the target user's active sessions.

## [1.5.2] - 2026-04-29

### Added

- **Admin Security Center (read-only).** New `/admin/security` page surfaces login activity (success / password failure / MFA failure aggregates by IP and email over a configurable 1h-7d window), active account lockouts read from the lockout service's Redis counters, active rate-limit blocks, and every non-revoked session across users with MFA / role / IP / UA metadata. SUPER_ADMIN sees everything; OPERATORs need the new `SECURITY_READ` platform capability (added to `MANAGER_PRESET`). Revoking another user's session from this page additionally requires `USER_MANAGE` and writes a `security.session.revoke` audit row tagged with the target user. Backed by `apps/api/src/security/`.
- **IP allow/deny rules.** New `/admin/ip-rules` page lets admins with `IP_RULE_MANAGE` capability create global IP-based access rules. Rules support single IPv4 addresses (192.168.1.1) or CIDR ranges (10.0.0.0/8) with ALLOW or DENY actions. Rules are evaluated in priority order (lowest first) by `IpRuleGuard`, which runs before `AuthGuard` on every request. First match wins; if no rules match, access is allowed (default-allow policy). All rule changes are audited (`security.ip_rule.{create,update,delete}`). The new `IP_RULE_MANAGE` capability is added to `MANAGER_PRESET`.
- **Egress / SSRF guard.** Every server-side outbound HTTP call (Action1 + UniFi integration drivers, RDAP / IANA bootstrap, `WEBSITE_DOWN` HTTP probes, HIBP password-leak check) now flows through a new `safeFetch` helper that resolves the target hostname and refuses to dial loopback, RFC1918, link-local, multicast, or cloud-metadata (`169.254.169.254`) addresses. Operators can punch holes for legit on-prem RMM endpoints via `EGRESS_ALLOWED_PRIVATE_CIDRS=10.42.0.0/16`, or short-circuit the entire guard for lab installs with `EGRESS_ALLOW_PRIVATE_NETWORKS=true`. The guard also caps response bodies (default 16 MB) and enforces per-call timeouts so a hostile origin can't pin a worker on a multi-gigabyte payload. Every refusal is recorded as `security.egress.blocked` and surfaced in the new **Egress blocks** tab of the Security Center.

### Security

- **Tighter default network surface.** `compose.yml` no longer publishes Postgres (5434) or Redis (6381) to the host, and MinIO's S3 port now binds to `127.0.0.1:9100` so a same-host reverse proxy can forward `MINIO_PUBLIC_URL` to it without exposing the bucket endpoint to the wider network. The MinIO admin console (9101) is no longer published by default.
  - Operators on existing installs who relied on host-side `psql` / `redis-cli` against compose: switch to `docker compose exec postgres psql ...` (or `redis-cli`), or layer `compose.build.yml` which still publishes the contributor dev ports.
  - Operators who genuinely need the MinIO console can layer the new `compose.console.yml` overlay (`docker compose -f compose.yml -f compose.console.yml up -d`) or SSH-tunnel `127.0.0.1:9101`.
  - Set `MINIO_HOST_BIND=0.0.0.0` in `.env` to restore the previous "publish on every interface" behavior (rarely the right answer for internet-facing installs).
- **Public health endpoint reduced to liveness only.** `GET /health` now returns `{ "status": "ok" }` with no version or backend diagnostics - those moved to authenticated `GET /health/ready` and `GET /health/queues` endpoints (require `AUDIT_READ` capability for the queue probe). External monitoring agents that scraped the old detailed payload should hit the new private endpoints with a session cookie or be replaced with `docker compose exec api curl ...` from inside the network.
- **Centralised client-IP handling.** Every controller, the audit interceptor, and the tenant-context interceptor now read the client IP from `req.ip` only (via the new `apps/api/src/common/request-meta.ts` helper) and never re-parse the raw `X-Forwarded-For` header. Before this change, hitting the API directly with a forged `X-Forwarded-For:` header could spoof the IP recorded in audit rows, evaded by the rate-limit and lockout services, etc. The new env var `TRUST_PROXY_HOPS` (default `1`) replaces the hardcoded `trust proxy` literal in `apps/api/src/main.ts` - bump it to match your real topology if you run multiple proxies in front of the stack (see [Security Configuration](/configuration/security/#client-ip-attribution)).

## [1.5.1] - 2026-04-29

### Fixed

- **IPAM resilience against malformed IP values.** The subnet occupants query no longer fails when an asset's `IP_ADDRESS` field somehow contains a non-canonical value (e.g. a multi-NIC RMM agent that flattens addresses to `10.0.0.35, 10.0.0.50`). Candidate values are now strict-regex-filtered in SQL and re-validated in JS, so a single bad row can never abort the entire IPAM read.
- **Driver-sourced field validation.** The `IP_ADDRESS` field strategy now refuses to persist values that don't round-trip through its schema, and the integration sync runner re-validates every projected value with the strategy's `valueSchema` before writing — preventing upstream drivers from leaking malformed values into typed columns.

## [1.5.0] - 2026-04-29

### Added

- **Folder editing.** Folders can now be renamed directly from the folder tree.
- **IPAM (IP Address Management).** A new dedicated IPAM module for managing IP addresses, subnets, and network ranges across tenants.

## [1.4.1] - 2026-04-28

### Added

- **SMTP email provider.** Added SMTP as an email delivery provider.
- **New alert system.** Introduced the new alert system.
- **UniFi integration.** Added a new UniFi integration driver.

### Changed

- **Improved Markdown editor.** Upgraded the Markdown editing experience.

## [1.3.0] - 2026-04-27

### Changed

- **Overhauled RBAC.** Permissions and access control were refactored to improve clarity, consistency, and maintainability across admin and portal experiences.
- **Updated global tags.** Global tags were refreshed and updated across the platform.

## [1.2.1] - 2026-04-26

### Fixed

- **Missing S3 SDK runtime dependency.** Added the missing AWS S3 SDK runtime package required in production so S3-backed features no longer fail at runtime due to missing module resolution.

---

## [1.2.0] - 2026-04-26

### Added

- **Articles can be authored as Markdown or Tiptap (per-article).** Storage uses `editor_mode` plus either Tiptap JSON (`content`) or raw Markdown (`markdown_source`); search continues to index `content_plaintext` for both. The admin article form includes a format toggle; switching formats on an existing article runs a one-time conversion with a confirmation dialog.
- **Vault records can now be exported to PDF.** Admin users can generate PDF exports directly from the vault workflow for sharing and archival.
- **Foundation for integration services is now in place.** Core sync orchestration and shared integration plumbing were introduced to support provider-specific connectors.
- **Action1 integration was added.** The first integration driver is now implemented on top of the new integration services foundation.

### Fixed

- **API JSON body limit raised to 2 MB.** Express's default 100 KB cap rejected legitimate article payloads — most visibly when converting a larger Markdown article to Tiptap, since the JSON representation expands past the threshold. The new limit comfortably covers the 500 KB `MAX_MARKDOWN_SOURCE` ceiling and its Tiptap projection while staying bounded against unbounded payloads.
- **Format switches no longer autosave.** Switching between Markdown and WYSIWYG is a deliberate, potentially-lossy conversion, so the form now waits for an explicit Save click rather than persisting the converted body 4 s later. The "unsaved" tag still appears, and any subsequent normal edit re-arms the autosave debounce.
- **Tiptap → Markdown table conversion no longer drops to raw HTML.** Tables without a `<th>` row are now promoted to a header row before Turndown sees them (GFM Markdown requires one), and `<p>` wrappers inside cells are unwrapped — joined with `<br>` for multi-paragraph cells — so the output is a clean GFM table instead of leaking the original `<table>` markup.

---

## [1.1.5] - 2026-04-24

### Added

- **Starred items now cover passwords, assets, and articles in addition to companies.** Operators can star or unstar each supported record from its detail page, then reopen it from the admin dashboard or the new sidebar starred drawer with type-specific icons, tenant context, archived-state labels, and direct links.
- **Per-user star storage now exists for every supported entity type.** New Prisma models and migration tables track starred passwords, assets, and articles with user/entity uniqueness and cascade cleanup. The `/me/stars` API now returns a single mixed list and exposes idempotent star/unstar routes for companies, passwords, assets, and articles.

### Fixed

- **Unauthenticated visits to `/` no longer emit a large RSC redirect body.** Next.js now handles the missing-session redirect to `/login` at the routing layer, avoiding noisy "Big Redirect" findings while preserving authenticated role-based routing.
- **Next.js static assets now ship minimal security headers.** The `/_next/static/*` tree gets `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy` even though the edge proxy skips Next internals for HMR compatibility.

---

## [1.1.4] - 2026-04-23

### Changed

- **Node.js 24 is now the minimum supported runtime.** Node 20 maintenance LTS reaches end of life on 2026-04-30. All Docker images (`api`, `web`, `worker`) now build on `node:24-alpine`, `engines.node` is `>=24.0.0`, and CI runs on Node 24. `@types/node` is pinned to `^24.0.0` across the workspace. Self-hosted deployments should confirm their host runtime is on Node 24 before upgrading.
- **pnpm 10 is now the workspace package manager.** `packageManager` in root `package.json` is pinned to `pnpm@10.33.2` and CI runs the same version. pnpm 10 no longer runs install scripts by default; the allow-list is declared in `pnpm.onlyBuiltDependencies` (prisma, @prisma/client, @prisma/engines, @nestjs/core, argon2, sharp, msgpackr-extract, unrs-resolver). Contributors should run `corepack enable` once; subsequent `pnpm` invocations inside the repo will auto-use the declared version.
- **TypeScript, Jest, and ts-jest bumped to the latest 5.x / 30 lines.** TypeScript 5.6 → 5.9, Jest 29 → 30.3, `@types/jest` 29 → 30, ts-jest floor raised to 29.4.9 (still the latest; ts-jest has not cut a v30 but its 29.4.x line is officially compatible with Jest 30). No test or jest config changes were required. A separate future PR will handle the TypeScript 5.x → 6.x jump, which has real breaking changes.
- **Zod floor raised from `^3.23.8` to `^3.25.0`.** Resolves to `zod@3.25.76`, the latest of the actively-maintained 3.x line. A full workspace-wide bump to Zod 4.x is deferred while an upstream `z.enum` inference regression is resolved.

### Fixed

- **Release workflow no longer hangs for 40+ minutes on worker `linux/arm64`.** The pipeline now builds each architecture on its native runner (`ubuntu-24.04` for `amd64`, `ubuntu-24.04-arm` for `arm64`) and a separate `manifest` job stitches them into a multi-arch image — no more QEMU emulation and no more illegal-instruction crashes during pnpm install.
- **pnpm 10 prod-prune step failed inside Docker with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.** pnpm 10 added a safety rail that refuses to remove/recreate `node_modules` non-interactively unless it detects it's running in CI. The api/worker Dockerfiles now prefix the prune step with `CI=true`.

### Deferred (for future PRs)

- **Prisma 5 → 6+.** Prisma 6 removes the `$use` middleware hook in favour of Client Extensions (`$extends`). Our `PrismaService` middleware enforces tenant isolation on every query — security-critical code that deserves its own dedicated migration PR.
- **TypeScript 5 → 6.** New defaults (`strict: true`, `types: []`, inferred `rootDir`) require a workspace-wide `tsconfig.json` audit; not a drop-in bump.
- **Zod 3.25 → 4.x.** Blocked on upstream inference fix for `z.enum(array)`.

---

## [1.1.3] - 2026-04-23
### Fixed

- **Client viewers can reveal permitted client-visible passwords again.** `CLIENT_VIEWER` memberships are now included in `password.reveal` authorisation, with existing visibility and restriction checks still enforced in the passwords service.
- **Article excerpts no longer render twice on read pages.** The separate excerpt block was removed from admin and portal article views to avoid duplicate intro text.
- **Article edit pages now expose file attachments.** The attachments panel is now available in the article form sidebar/sheet so operators can manage uploads during editing.
- **Article browser layout now shrinks correctly in split panes.** Added the missing `min-width: 0` constraint to prevent overflow in constrained admin layouts.
- **Password detail pages now show the linked asset name.** The linked asset is resolved and displayed as the outbound link label instead of generic copy.
- **Password reveal and inline warning surfaces use valid theme tokens.** Replaced stale CSS variables with supported tokens so reveal states and warning chips render consistently across themes.

---

## [1.1.1] — 2026-04-23

### Added

- **Asset layout rename & archive.** Global asset layouts can now be renamed in place and archived (soft-deleted) from the layout list. A dedicated archive dialog warns before removing a layout still in use by existing assets. Archived layouts stop appearing in the asset creation picker but remain viewable on historical assets.
- **"Other" free-text option on dropdown fields.** Asset layout dropdowns can opt in to an "Other…" escape hatch that lets users enter a one-off value without polluting the shared option list.
- **Reorderable dropdown & multiselect options.** Drag-and-drop reordering of option lists in the asset layout builder.
- **IP address field type.** New first-class field kind for asset layouts (IPv4/IPv6, optional CIDR). Lays the groundwork for the upcoming IPAM feature.

### Fixed

- **Text file uploads rejected as `audio/mpeg`.** UTF-16 LE's `FF FE` byte-order mark collides with the MPEG frame-sync pattern, causing BOM-prefixed `.txt` files (BitLocker recovery keys, Notepad exports, Excel CSVs) to be rejected on upload. Uploads now peek for UTF-8/16/32 BOMs before running `file-type` and short-circuit to `text/plain`.
- **429 rate limits masquerading as 404s in SSR.** The global throttler previously keyed every authenticated request on the Express socket peer — the web container's internal bridge address, shared by all operators. Rate limiting is now keyed on `req.user.id`, and 429 responses surface a dedicated error panel with a cooldown timer and auto-retry button.
- **Safari constantly prompting to save passwords.** The password create/edit dialog's inputs looked like a login form to Safari's password manager. Fixed via input naming, autocomplete hints, and corrected form semantics.

---

## [1.1.0] — 2026-04-22

### Added

- **Password vault.** Per-tenant password manager with envelope-encrypted secret, notes, and TOTP fields. Every ciphertext is stamped with a key ID (`PASSWORD_ENCRYPTION_KEY_KID`) so keys can be rotated without downtime. Version history, archive/restore, credential attachments, and a full reveal-audit trail are first-class.
- **Password generator.** Local, offline generator with words + symbols, passphrase, and custom-length modes. A 200-word EFF-style wordlist ships with the web app.
- **zxcvbn strength meter** on password entry, with realtime score, warning, and suggestions.
- **HaveIBeenPwned breach check.** Worker-side k-anonymity lookup (SHA-1 prefix only) on every password create/update. Toggled by `HIBP_ENABLED` (default `true`).
- **Expirations tracker.** Global `/admin/expirations` and per-company views rolling up upcoming and past-due expiry dates across assets and passwords.
- **Audit log pagination.** Server-side cursor pagination with configurable page size and URL-sticky filters.
- **MFA QR code** rendered inline during TOTP enrollment.
- **`reencrypt-passwords` CLI.** Bulk re-encryption after a key rotation or blob-format migration.

### Changed

- `prisma migrate deploy` now runs inside the `api` container on startup instead of as a separate one-shot `migrate` service. Removes the exit-0 container that some Docker UIs flagged as an error.
- Persistent data now lives in bind-mounted host folders under `$DATA_DIR` (defaults to `./data`) instead of named Docker volumes.
- `compose.yml` no longer hard-codes a Compose project name.
- `scripts/keygen.sh` / `scripts/keygen.ps1` now emit `PASSWORD_ENCRYPTION_KEY` alongside other secrets.

### Fixed

- Sharp (libvips) native module on `linux/amd64` musl.
- Docker `web` image now builds `@weavestream/shared` before the Next.js build step.

### Upgrading from 1.0.0

1. Re-download `compose.yml` and `.env.example` from the `v1.1.0` tag.
2. Add `PASSWORD_ENCRYPTION_KEY` and `PASSWORD_ENCRYPTION_KEY_KID` to `.env`.
3. Optionally set `HIBP_ENABLED=false` if your deployment cannot reach `api.pwnedpasswords.com`.
4. Migrate existing data from named volumes to bind-mount folders before the first `up` (see the [upgrade guide](/deployment/upgrades/)).

---

## [1.0.0] — 2026-04-21

Initial public release.

### Highlights

- Postgres-backed, Docker-first IT documentation platform.
- Tenant documentation with Tiptap-based rich-text articles, folders, photo galleries, and per-organisation asset layouts.
- Invite-only user management with forced TOTP MFA and append-only audit logging.
- Two-layer RBAC: global roles combined with per-tenant memberships.
- Read-only client portal per tenant, with server-side field scoping.
- MinIO-compatible object storage with one bucket per tenant.
- Domain & SSL expiry monitoring.
- Full-text search across articles, assets, and uploads.
- Configurable workspace branding and tenant terminology from the admin UI.
- Mobile-responsive admin shell and client portal.
- Multi-arch container images (`linux/amd64`, `linux/arm64`) at `ghcr.io/weavestream/weavestream-*`.

### Known limitations

- No built-in TLS termination; front with a reverse proxy.
- Single-tenant Postgres (shared schema with `companyId` scoping).
- English UI only.

---

[Unreleased]: https://github.com/Weavestream/Weavestream/compare/v1.8.6...HEAD
[1.8.6]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.6
[1.8.5]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.5
[1.8.4]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.4
[1.8.3]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.3
[1.8.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.1
[1.8.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.0
[1.7.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.7.1
[1.7.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.7.0
[1.6.4]: https://github.com/Weavestream/Weavestream/releases/tag/v1.6.4
[1.6.3]: https://github.com/Weavestream/Weavestream/releases/tag/v1.6.3
[1.6.2]: https://github.com/Weavestream/Weavestream/releases/tag/v1.6.2
[1.6.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.6.0
[1.5.6]: https://github.com/Weavestream/Weavestream/releases/tag/v1.5.6
[1.5.5]: https://github.com/Weavestream/Weavestream/releases/tag/v1.5.5
[1.5.4]: https://github.com/Weavestream/Weavestream/releases/tag/v1.5.4
[1.5.3]: https://github.com/Weavestream/Weavestream/releases/tag/v1.5.3
[1.5.2]: https://github.com/Weavestream/Weavestream/releases/tag/v1.5.2
[1.5.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.5.1
[1.5.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.5.0
[1.4.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.4.1
[1.4.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.4.0
[1.3.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.3.0
[1.2.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.2.1
[1.2.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.2.0
[1.1.5]: https://github.com/Weavestream/Weavestream/releases/tag/v1.1.5
[1.1.4]: https://github.com/Weavestream/Weavestream/releases/tag/v1.1.4
[1.1.3]: https://github.com/Weavestream/Weavestream/releases/tag/v1.1.3
[1.1.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.1.1
[1.1.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.1.0
[1.0.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.0.0
