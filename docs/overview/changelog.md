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

## [1.9.3] - 2026-07-30

### Fixed

- **The mobile app was unreachable at `/m` behind a reverse proxy.** Opening `/m` redirected to the address the *server* was reached on rather than the one you typed, so on a typical proxied deployment it bounced the browser to an internal address (commonly `http://localhost:3000/m/app`) that only resolves on the host itself. The redirect is now relative, so it lands on whichever address you are already using. `/m/app` was never affected — if you hit this, that was the workaround. **Note:** browsers cache this kind of redirect indefinitely, so after upgrading, a device that already saw the bad one keeps following it until you clear that site's website data.

### Security

- **The `/m` redirect no longer trusts the request's `Host` header.** Because the redirect target was built from the incoming host, a deployment whose edge proxy forwards a client-supplied `Host` verbatim could be made to answer a request for `/m` with a redirect to an attacker-chosen address — a phishing stepping stone that borrows your domain's credibility. The redirect no longer references the host at all. Deployments whose proxy sets `Host` itself (the configuration in the [TLS guide](/deployment/tls/)) were not exposed to the redirect, only to the bug above.

## [1.9.2] - 2026-07-30

### Added

- **Mobile app for field technicians.** Weavestream now ships a dedicated mobile interface at **`/m`**, served from the existing web container — no separate deployment, no app store, nothing to license, and the same accounts, sessions, permissions, and audit trail as desktop. It installs as a PWA (home-screen icon, standalone window) and opens on a **launcher** that works before any client is selected: search across every organization you can access, your pinned organizations, then the full list. Included on the phone: **passwords** (create, edit, archive, reveal with the same step-up re-authentication and reveal auditing as desktop, one-time codes with countdown, copy with automatic clipboard clearing), **articles** read-only in both rich-text and Markdown, **assets** across custom layouts including file fields with direct camera capture for serial plates and racks, **attachments** on asset, article, and password detail screens, **search**, and **Ask anything** — where article change proposals can now be previewed, applied, and rejected, with edits shown as a line diff and creates confirming organization, folder, title, and client visibility first. A **Profile** screen covers the account chores worth doing onsite: appearance and change-password. The app follows the account's theme and accent and picks up changes made on desktop. **Records are never stored on the device** — the app itself opens offline, but data requires a connection and revealed secrets clear when the app is backgrounded. Article editing, rich-text asset fields, MFA enrollment, and all administration stay on a laptop by design. See the [Mobile App guide](/features/mobile/).
- **Mermaid diagrams in Markdown articles.** A ```` ```mermaid ```` fence now renders as a flowchart, sequence, class, ER, state, gantt, or git diagram — in the desktop article view, in the editor's live preview, and in the mobile reader — themed from the reader's own dark/light mode and accent. Every rendered diagram passes through a shared sanitizer before it reaches the page (see **Security**). The diagram engine loads only when an article actually contains one, and on mobile it is deliberately excluded from the offline cache, so an installed app that is offline shows the diagram source with an explanation rather than a blank space.
- **AI article summaries (opt-in, off by default).** A new **"Use AI to create auto summaries"** setting under AI settings sends an article's title and text to your configured AI endpoint when it is created or edited, and shows the returned one-to-two-sentence summary in article lists; articles without one fall back to a plain excerpt. Existing articles are never summarized until their next edit, so enabling the setting does not ship your back catalogue anywhere. Generation runs in the background one at a time, and bulk integration imports drain through a paced sweep rather than flooding the endpoint.
- **"Ask anything" can draft a new article from any chat.** The create-article proposal is no longer withheld from chats opened outside a company — a chat started from the mobile launcher, or from a global page, can now propose an article and let you choose its destination organization, folder, title, and client visibility in the confirmation step. Previously such a chat still wrote the draft into the transcript, just with no way to save it.
- **Search from the page header.** The top bar gained a search button (with the ⌘K hint) beside the breadcrumb trail, and the trail's head is now a scope chip pairing the company name with the current section, pointing at the company picker.
- **Sidebar item counts are now a preference.** Counts next to sidebar entries (assets per layout, domains, passwords, subnets) are off by default and enabled per user under **Your profile → Appearance**. Warning badges are unaffected — an anomaly stays visible at any density.

### Changed

- **Article editor chrome unified.** The rich-text and Markdown editors now share one toolbar and one surrounding frame, with the view-mode switch lifted to the article form so it sits alongside the editor's own controls instead of duplicating per mode.
- **Desktop file fields now behave exactly like the mobile ones.** Cancel, Retry, and Dismiss on in-flight uploads; per-field `accept` and maximum-size enforcement instead of the instance-wide limit alone; single-file fields treated as single (the previous default let you upload a set the API then rejected); Save blocked while an upload is in flight; and a cancelled edit form no longer leaves the file durably attached to the record.
- **The "Save as article" dialog pins the organization to the chat's.** A chat opened from a company page now shows that organization fixed while title, folder, and visibility stay editable. Previously the picker accepted any organization and the server created the article in the chat's original one regardless — or failed confusingly when a folder from the picked one was selected.
- **Article and asset lists return less data.** Article list rows are metadata-only (no body — some are ~500 KB each) and asset list rows carry only the field values lists actually render. Detail pages are unchanged. This makes long lists dramatically lighter, particularly on a phone.
- **Muted text and accent colours retuned for contrast.** The shared `--muted`/`--dim` tokens were raised to clear WCAG AA, accent ink now resolves to dark text on light accents, and mobile carries a further contrast bump for small text read in daylight.

### Fixed

- **Uploads larger than 10 MB failed.** The web tier buffers request bodies for replay and silently truncated anything past Next's 10 MB default, so every upload between 10 MB and your configured `MAX_UPLOAD_MB` died mid-transfer with an unhelpful error, on both desktop and the mobile app. The buffer is now sized from `MAX_UPLOAD_MB` (default 25 MB), leaving the API as the only layer that rejects an oversized file — with a proper error instead of an aborted connection.
- **Files with emoji or CJK characters in their names could not be opened.** The download response header rejected any character above U+00FF, so the request failed before a byte was sent. Filenames are now normalized when the file is saved, and the download header is safe for names stored before this release, which keep their original text in the save dialog.
- **The installed mobile app could hang on launch or navigation.** Offline fetches on iOS can stall rather than fail, and the previous caching strategy waited on them indefinitely — wedging navigation and blocking a new app version from activating. Every step now completes within a deadline and falls back to the cached app shell.
- **Chat requests kept running after the browser disconnected.** Closing a tab or navigating away mid-answer now stops the turn immediately, including during ownership checks, message persistence, and prompt preparation, instead of finishing the work and the model call for nobody.
- **Password-change errors no longer conflate a wrong password with an expired session.** Both returned an indistinguishable 401, so one of the two was always handled wrongly — either stranding a signed-out user retyping a correct password, or signing someone out over a typo. The response now identifies the cause, and both the desktop and mobile forms mark the current-password field or route to login accordingly.
- **Discarded draft text could survive in article lists.** Discarding a draft (or archiving an article that had one) restored every part of the published article except the list excerpt, which kept showing text derived from the discarded draft.

### Security

- **Regenerating MFA backup codes now requires step-up re-authentication**, matching the other sensitive account actions, and the generated codes are handled as one-time delivery — shown once, never persisted by the app, never re-served.
- **Expired memberships are now filtered from company listings and starred items.** Both filtered on revocation alone while the permission resolver also honours expiry, so a lapsed membership could still list its companies and keep serving starred passwords, assets, and articles — names, usernames, and company names — to a principal every permission check would deny.
- **Rendered diagrams pass a fail-closed sanitizer.** Diagram source is author-controlled text that can reach a client-portal reader across a tenant boundary, and article bodies are routinely AI-authored, so each generated SVG is sanitized in one shared module before it touches the page: an explicit element/attribute allowlist, a URL gate covering `href`/`xlink:href` and every URL-capable presentation attribute (routed through the same policy article prose links use), a CSS gate that rejects `@import`, external `url()` in any spelling, and `:host` selectors, and shadow-root containment so a diagram's stylesheet cannot escape into the page. The renderer runs in its strictest mode with text and edge limits well below its defaults. No Content Security Policy directive was loosened to make diagrams work.
- **Applying and rejecting an AI article proposal is now serialized and idempotent.** The apply/reject path takes a lock whose statement carries the ownership check itself, so a request naming another user's message matches nothing and acquires nothing; concurrent settles fully serialize; and a create records its confirmed intent before any article is written, so a crash mid-apply can never produce a duplicate article or silently relocate one on retry.
- **A create confirmation whose organization differs from the chat's is refused** rather than silently redirected to the chat's organization, and the article title reported after a crash-recovery settle is disclosed only to an actor who can still read that specific article — including the client-visibility restriction on the row, enforced in the query rather than after the fetch.
- **Cross-organization search excludes archived (offboarded) organizations.** Archiving a company never touched the search index, so its records kept surfacing in global search for every role — and a technician following such a hit on mobile would have been switched into an offboarded client. Searches explicitly pinned to a company are unchanged.
- **AI summary generation cannot see unpublished text.** Articles holding an in-progress autosave draft are excluded from generation and from the reconciliation sweep, so draft content is never sent to the AI endpoint or served in a list. Provider error bodies — arbitrary upstream text that can echo the prompt or a credential — no longer reach worker logs; failures are logged as a bounded classification drawn from our own string constants plus a hash fingerprint. A database default (migration 0068) ensures articles written by an older instance during a rolling deploy land settled rather than queued for summarization.
- **A malformed article heading could stall reconstruction completeness parsing.** The header pattern backtracked exponentially on crafted input; it is now linear.
- **Code-fence languages are normalized before export.** A code block's language was written verbatim into the Markdown projection used by PDF export, so a language containing newlines could inject Markdown structure into the exported document.
- **The mobile app's Content Security Policy is a separate, documented policy.** The `/m` branch drops `strict-dynamic`, which CSP3 would otherwise use to ignore `'self'` and block the app's own scripts — a real loosening of `script-src`, scoped to that path only and pinned by tests. The mobile service worker never routes `/api` traffic, so it cannot touch credential requests or the chat stream, and its one message handler now verifies the message's origin.

### Documentation

- **New [Mobile App](/features/mobile/) guide** covering the launcher, installing on Android and iOS, what is and is not on the phone and why, offline behaviour, the profile screen, and notes for administrators.
- **Upload size limits** documented against `MAX_UPLOAD_MB` in [environment configuration](/configuration/environment/) and [files](/features/files/).
- **Step-up requirements** for backup-code regeneration added to the [authentication](/security/authentication/) page.

## [1.9.1] - 2026-07-24

### Fixed

- **The worker container no longer crash-loops on startup.** 1.9.0 wired the integration reconstruction writers into the worker so they could create native assets, subnets, articles, and relations through the same services the API uses. That pulled `AssetsService` — and transitively the uploads and passwords services — into the worker's module graph for the first time. Those services require `sharp`, `otplib`, `file-type`, and the `@zxcvbn-ts` packages, which were declared only by the API and therefore absent from the worker image, so the worker exited with `Cannot find module 'sharp'` before it could consume a single job. The worker now declares the six runtime packages it actually loads. Background work handled by the worker — integration syncs, scheduled backups, company exports and PDFs, alert email, and thumbnail generation — was unavailable while the container was restarting; the API and web containers were unaffected.

## [1.9.0] - 2026-07-24

### Security

- **Dependency advisories patched.** `sharp` moves to 0.35.3 (libvips 8.18.3), clearing four inherited libvips CVEs (CVE-2026-33327, -33328, -35590, -35591) that applied to image upload, thumbnail, and PDF export processing. `postcss` is pinned to 8.5.19 through a resolution override, clearing an arbitrary file read (GHSA-6g55-p6wh-862q) and a path traversal (GHSA-r28c-9q8g-f849) via `sourceMappingURL` auto-loading — Next.js pins postcss exactly, so an override is the only way to move it. Next.js moved to 16.2.11, clearing two SSRF advisories, an App Router middleware bypass, and a denial of service.

### Added

- **Breeze reconstruction sync.** A new read-only integration driver copies durable, non-secret reconstruction facts from Breeze into native Weavestream records via the Breeze Partner API. It does not install an agent, copy monitoring state, run commands, or write back to Breeze, and the resulting company data, export, and PDF stay usable when Breeze is offline. Enabled resources execute as an acyclic dependency graph — sites before devices, subnets before reservations, endpoints before relations — with cycles rejected. Runs come in three modes: **dry run** (fetch, validate, transform, report, roll back), **incremental** (from the last committed high-water checkpoint), and **full** (complete source snapshot; only a terminal authoritative full traversal may mark unseen records stale). Requires the Partner API surface introduced in the July 2026 Breeze release; older Breeze deployments return 404 for every partner request. See the [Breeze integration guide](/integrations/breeze/).
- **Integrations can now write native records beyond assets.** The reconstruction layer adds typed target writers for **IPAM subnets and IP reservations**, **versioned internal articles** (configuration policies, assignments, scripts, automations, backup configurations, and custom-field definitions), and **relations** between synced records — alongside the existing asset writer. Each target carries its own Breeze-owned binding; missing or cross-company relation endpoints become safe gaps rather than dangling or cross-tenant edges.
- **Per-resource ownership rules.** Each mapping now declares how sync interacts with operator edits: **Source wins** (always update from the provider), **Preserve manual** (accept the provider until an operator changes the value, then keep the operator's), and **Manual only** (never written by sync). Only an exact provider-owned binding for the same integration, organization mapping, resource, company, target kind, and native target may mutate that target — sync can never claim a manual or differently-owned record.
- **Reconstruction completeness view.** A new tab on the integration detail page reports six separate states per scope — *Synchronized current*, *Manually documented*, *Secret blocked*, *Missing*, *Stale*, and *Synchronization error* — with a paginated list of active gaps filtered by organization mapping and resource. Backed by new `integration.manage`-gated `/completeness` and `/gaps` endpoints.
- **Source provenance on record detail pages.** Assets, articles, and subnets show where their data came from — source label and resource, first seen, last seen, last synchronized, stale since, and whether the record is source-owned or Weavestream-owned. Provenance sits behind a new collapsible "show more" disclosure alongside activity history, with a coloured attention dot so a stale or blocked source record is never buried entirely.
- **Opt-in scalar custom fields.** Custom-field definitions and values are walked through independent cursors and mapped per definition: a mapping's source field is the immutable definition ID and its target is a distinct field on the provider's asset layout. A value row writes only the field mapped to its definition; unmapped definitions write no native state, and the mutable provider field key/name stay display metadata rather than mapping identity.
- **Sync schedule interval picker.** Integration create and credentials surfaces now offer human interval presets (every 5 minutes through every 24 hours) instead of a raw cron box, shared across all drivers. Storage remains a five-field UTC cron, so existing rows and the API contract are unchanged; a hand-entered cron that matches no preset is surfaced as a "Custom" option holding the exact value and is never silently rewritten.
- **Manual runs can select incremental or full mode.** The trigger-sync action now takes an explicit mode instead of always deciding for the operator.
- **Reconstruction dossier in company export and PDF.** Ordinary company exports and PDFs now include reconstruction summaries, safe completeness gaps, source provenance, and stale-record labels on assets, subnets, and relations. The dossier uses local labels and contains the essential procedure text — raw provider payloads, provider configuration, rejected values, and secret-derived content are excluded — and the section renders only for companies with an active reconstruction integration.
- **Full Unicode coverage in PDF exports.** Exports now embed Noto Sans CJK JP (regular and bold) and check glyph coverage with `fontkit`, so CJK and other non-Latin content renders instead of dropping out. Credential text renders byte-exact or is flagged with explicit `[U+hex]` notation rather than silently losing characters.
- **Sidebar nav can be pinned by the page.** Asset detail pages now highlight their layout's sidebar entry instead of "All assets", via a page-mounted active-item override that URL prefix matching cannot express.

### Changed

- **Default integration sync cadence is now every 15 minutes.** `INTEGRATION_SYNC_DEFAULT_CRON` changed from `0 */4 * * *` to `*/15 * * * *`. Setting it to `off` now disables only *inherited* schedules — integrations with an explicit `syncCron` continue to run on their own schedule, and manual runs are unaffected.
- **Organization mappings can no longer be reassigned to a different company.** Editing a mapping's company was accepted before; it now returns a 400 asking the operator to delete the mapping and create a new one, so an established set of native targets cannot silently change tenant.
- **Driver resource descriptors gained target metadata.** Resources now declare their target kind, target configuration, dependencies, and whether they are enabled by default. Action1, NinjaOne, UniFi, and Cloudflare declare asset targets and opt out of reconstruction completeness — their sync behaviour is unchanged. Breeze device relationships ship disabled by default.
- **Integration field-mapping UI adapts to the target kind.** Non-asset resources get their own editors (folder/visibility/template for articles, CIDR and reservation identity for IPAM, dependency and relationship-type mapping for relations), and disabled resources explain what enabling them will configure.
- **Sidebar widened from 232 px to 248 px.**
- **API container health check start period raised from 120 s to 240 s**, sized for migration 0062 queuing behind in-flight sync page transactions plus headroom for its index builds.
- **In-app AI help content for integrations rewritten** to cover reconstruction targets, ownership rules, completeness, and run modes; the separate integration-syncs help page was folded into it.

### Fixed

- **Manual edits to integration-authored fields now survive later upstream changes.** The original integration-authored checksum is retained when an operator edit is detected, so a "preserve manual" field is not re-captured by the next sync that touches the record.
- **Markdown tables no longer break on backslashes.** The Tiptap → Markdown converter escapes backslashes before pipes, so a cell containing `\` produces a valid GFM table instead of corrupt row grammar.
- **Repeated scheduler deliveries no longer create duplicate runs.** Scheduled syncs carry a stable delivery key, at most one full run per integration may be queued or running, and a racing full request falls back to incremental.
- **Tag creation inside a transaction writes its audit row on the same client**, so a rolled-back write can no longer leave an orphan `tag.create` audit entry.

### Security

- **Password-protected PDF exports now use AES-256.** Encrypted exports select PDF 1.7 Extension Level 3 (V=5/R=5, AESV3), replacing PDFKit's default 40-bit RC4 handler, with explicit permissions that keep credential text copyable for readers that authenticate. Unencrypted exports keep the byte-stable PDF 1.3 output. CBC is fixed by the PDF standard, so the workspace AES-256-GCM rule cannot apply to in-file PDF encryption.
- **Secret-like reconstruction content is quarantined, not stored.** A bounded scanner rejects provider content matching credential key names, bearer/basic headers, PEM private keys, credential-bearing URLs and query parameters, common provider token prefixes, AWS access key IDs, JWTs, and high-entropy strings. Rejected items become a `secret_blocked` gap that names the fact without ever persisting the value, and no bypass is offered. Password values are never requested from the provider or decrypted for reconstruction.
- **Tenant scope enforced on every reconstruction read and write.** Reconstruction reads are company-scoped at the query layer, cross-company endpoints degrade to safe gaps, and writes are guarded by recency and tenant predicates rather than check-then-act.
- **Asset external identity is now unique at the database layer** (migration 0062, partial unique indexes for sourced and NULL-source rows), with unique-violation races classified and retried instead of surfacing as errors. The migration dedupes existing duplicates and parks any bindings it could not retarget — because a concurrent sync transaction held them — in a helper table that a background drain service converges after deploy.
- **Concurrent canonical writes can no longer lose updates.** Reconstruction gained a per-scope watermark row that serialises gap mutations, a scope serialisation lock for syncs, and `clearedAt` tombstoning so an older concurrent evaluation cannot revert newer scope state.
- **Canonical network identity enforced in the database.** Migrations 0064 and 0065 pin subnet CIDRs to their canonical form and normalise gateway, DHCP bounds, and reservation host IPs to canonical dotted-decimal, so alias spellings of one network or host can no longer defeat the unique keys.
- **Reconstruction input is bounded by bytes, not just row counts**, with a transform-size preflight, per-page record and gap caps, page-count and write-attempt limits, and bounded configuration inspection that fails closed on error.
- **Reconstruction lifecycle audit rows carry safe payloads only.** `integration.target.created`, `.updated`, `.stale`, `.restored`, and `.blocked` record local integration/mapping/resource/target identity, target kind and state, bounded counts, and an optional safe reason category — never external IDs, raw source or provenance data, provider configuration, content, gap details, rejected values, or credentials. Resources fail closed as `missing_audit_actor` before any native writer runs when no authorised actor is available.
- **Partner API credentials are encrypted at rest** with the kid-tagged `INTEGRATION_SECRET_KEY` envelope, sent only in the `X-API-Key` header, never refilled as plaintext in the UI, and never forwarded across redirects. Outbound requests keep the existing SSRF and DNS-rebinding guard, with each redirect hop revalidated rather than treated as an allowlist bypass.
- **UUID redaction widened to RFC 9562.** The export redaction pattern now covers UUID versions 6–8 in addition to the previously matched versions.
- **CI fails when PDF inspection tooling is missing.** The company-PDF-export specs shell out to Poppler and libxml2 to verify rendered credential text, AES-256 encryption, and exported XMP. They skip with an install hint on a clean contributor checkout, but CI installs both and sets `WEAVESTREAM_REQUIRE_PDF_TOOLS=1` so a broken install step fails the build instead of silently dropping that coverage.

### Documentation

- **Integrations documentation promoted to its own section.** `/features/integrations/` was replaced by a dedicated `/integrations/` area with an overview page and per-provider guides for [Action1](/integrations/action1/), [Breeze](/integrations/breeze/), [Cloudflare](/integrations/cloudflare/), [NinjaOne](/integrations/ninjaone/), and [UniFi](/integrations/unifi/).
- **Breeze operations guide** covering required read scopes, private-deployment egress configuration, resource ordering, ownership rules, run modes and scheduling, retry/limit/checkpoint bounds, completeness states, export and offline recovery, and recovery playbooks for credential failure, schema/cursor failure, rate limiting, and blocked definitions.
- **Development prerequisites** now list the optional Poppler and libxml2 command-line tools used by the PDF export specs.

## [1.8.15] - 2026-07-14

### Added

- **Patch-first AI article editing.** Focused AI edits now propose exact passage replacements instead of regenerating the complete article, reducing output size and preserving unchanged content more reliably on smaller local models. Whole-document replacement remains available for explicit rewrites. Patch previews and Apply share the same exact-match rules, and stale, missing, or ambiguous passages are refused without partial writes.
- **Product help AI tool (`get_app_help`).** The chat assistant can now answer "how do I use Weavestream" questions — creating asset layouts, configuring integrations, mapping organizations, running syncs — from release-matched instructions bundled with the deployed application. The content is read-only and strictly separated from live tenant data: it explains the current UI and required permissions but cannot inspect real assets, mappings, or sync state, and when no help section qualifies with sufficient confidence the assistant says so rather than guessing. Deployment, Docker, environment, database, and server-administration topics are intentionally excluded. Access is scoped to non-portal roles (`CLIENT_USER` excluded), and every call is audited with the question and returned content redacted to SHA-256 hashes.
- **Installable app (PWA).** Weavestream now ships a web app manifest and standalone icons (including a maskable variant), so it can be installed to a device home screen or dock and launched as a standalone window.
- **Profile "Memberships" tab.** The profile page now lists the signed-in user's company memberships and their per-company roles alongside the existing profile, appearance, security, and sessions tabs.

### Changed

- **Layout builder field palette refreshed.** The asset layout builder now promotes the most common field types for quicker access, labels field types by their display name instead of internal slugs, adds an explanatory tooltip to the Linked Asset field type, and expands the available layout color and icon options.
- **AI chat links open in the current tab.** Markdown links in assistant responses no longer force a new browser tab, keeping navigation consistent with the rest of the app.

## [1.8.14] - 2026-07-10

### Added

- **AI agent read tools (WS-030).** The chat assistant can now call dedicated `search`, `get_article`, `get_related_items`, and `get_company_summary` tools during streaming chat, with a real-time "Searching..." indicator in the UI. Tool access is scoped server-side, hourly per-user/per-conversation usage budgets are enforced, and `Article.revision` now backs optimistic-concurrency checks so an AI-proposed edit cannot silently clobber a change made elsewhere in the meantime.
- **Connection diagnostics endpoint.** A new `/api/v1/security/whoami` endpoint and matching Security Center tab show how a request's IP and headers were attributed through the proxy, to help verify reverse-proxy/topology configuration. Raw headers are surfaced for display only and are never used in auth decisions.
- **Opt-in AI access to private-network endpoints.** Admins can enable `allowPrivateNetwork` under AI settings to reach self-hosted model providers (e.g. Ollama, LM Studio) on the local network. Access is limited to a curated `ADMIN_PRIVATE_ENDPOINT_CIDRS` allowlist rather than a broad SSRF-protection bypass, and cloud metadata/link-local ranges remain blocked.
- **Broader upload file type support.** HEIF, EML, and a legacy JPG alias are now accepted, with server-side and client-side MIME lists kept in sync by a new regression test.

### Changed

- **Global access permissions simplified.** `requireNonExpiredMembership` was replaced with a single `globalAccess` policy; the "operator" role now defaults to global access, overridable by specific company memberships. The user management UI clarifies how overlapping permissions are displayed.
- **Auth rate limiting now keys on IP + email pairs**, so brute-force protection on login no longer locks out unrelated users sharing a network with an attacker targeting a different account.
- **AI tool failures can now carry tool-specific guidance messages** shown to the model, while `not_found` and `denied` outcomes remain indistinguishable from each other in tool responses to avoid leaking existence information.
- **API error handling and metadata fetching refactored.** Error types/constants now come from a shared client-safe module; metadata generation degrades gracefully during backend outages, and the global error boundary distinguishes backend-unavailable from rate-limited responses.
- **Email settings test form layout improved on mobile.**

### Fixed

- **Folder moves now validate the destination parent.** Moving a folder checks that the new parent exists in the same company and is not archived, closing a gap that allowed folders to be relocated across company or archive boundaries.
- **Invite tokens are now enforced single-use at the database level**, using a conditional update with explicit `consumedAt`/`expiresAt` checks instead of a check-then-act pattern, closing a race window that could allow one invite to be redeemed twice.
- **Orphaned upload directories are now cleaned up.** A new `upload_reaper` worker sweep removes filesystem directories left behind by uploads that started but were never confirmed, based on configurable age thresholds.

### Security

- **Encrypted blobs are now bound to their identity via AEAD.** The AES-256-GCM envelope (format version bumped to `0x02`) includes Additional Authenticated Data derived from tenant, record, and field context, so a ciphertext copied from one record to another fails to decrypt instead of decrypting into the wrong context. Legacy `0x01` blobs are migrated transparently via `reencryptIfStale`.
- **Content Security Policy tightened for proxied images and objects.**
- **Browser-executable MIME types are rejected in upload configuration.** The `ALLOWED_UPLOAD_MIME` environment variable is validated at boot to reject types like HTML and SVG that can execute scripts when rendered inline.
- **Backup and export downloads now send `X-Content-Type-Options: nosniff`.**
- **Alert recipient lists are capped to prevent amplification (WS-031).** A shared `MAX_ALERT_RECIPIENTS` limit is enforced by both schema validation and a fail-closed backstop in `EmailService`, with clearer UI messaging when a recipient list is rejected.
- **Password changes now have brute-force protection.** A per-user lockout in `LockoutService`, enforced by `MeService` with request throttling and audit logging, mitigates attempts to grind the current password of an already-compromised session.
- **Refresh token endpoint is now rate limited** to 20 requests per minute per IP.
- **Tag and search pagination offsets are capped** at 10,000 to prevent expensive O(n) scans and CPU-exhaustion attacks via deep pagination.
- **Alert emails no longer render untrusted HTML**, removing an HTML-injection path into recipients' mail clients.
- **IP rules endpoint now requires a multi-layered internal guard.** The web tier's polling of the active IP ruleset now requires both a private TCP peer and a shared secret derived from `COOKIE_SIGNING_KEY`, with a 404 fallback for unauthorized access at the proxy layer, closing an SSRF/smuggling path to internal APIs.
- **Image processing now gates against decompression bombs (WS-027).** Extreme-dimension images are rejected before decode, thumbnail generation is bounded by a concurrency semaphore, and oversized images are filtered safely out of PDF exports.
- **Password verification timing is now equalized.** Login attempts against non-existent or inactive accounts run against a dummy Argon2 hash so response latency no longer reveals account existence.
- **Asset purging now enforces server-side archive requirements.** Permanent deletion requires re-authentication and a strict server-side check that only archived items are removed, with UI handling for mixed filtered/active selections.

## [1.8.13] - 2026-07-03

### Fixed

- **Admin tools no longer crash on self-hosted installs served over plain HTTP.** When Weavestream is opened over `http://` by IP address (for example `http://192.168.1.20:3000`), the browser treats the origin as non-secure and does not expose `crypto.randomUUID()`, which produced a `crypto.randomUUID is not a function` error in the layout builder (creating a layout from a template or dragging in a new field), integration field-mapping rows, and AI chat tabs. These browser-only temporary IDs now use a shared helper that falls back to the Web Crypto `getRandomValues` API, which remains available on non-secure origins. Serving Weavestream over HTTPS behind a TLS reverse proxy remains the recommended production configuration.

## [1.8.12] - 2026-07-03

_No notable changes._ Documentation-only maintenance release (Docker troubleshooting notes); no application changes since 1.8.11.

## [1.8.11] - 2026-07-01

### Added

- **File uploads now stream directly to storage.** Uploads are written through the storage layer without buffering the full object in memory. Size limits are enforced while bytes are read, object metadata can be checked without loading the file body, and a Redis-backed write-once guard protects the upload/confirmation lifecycle.
- **Audited super-admin upload recovery tools.** Super admins can now restore tombstoned uploads and, when needed, explicitly reveal an upload's storage path through a separate audited action.

### Changed

- **Date and time rendering is now SSR-safe.** Shared deterministic date formatters and a web timezone provider prevent React hydration mismatches caused by differing server/client ICU behavior or system timezones.
- **Integration and egress errors are easier to diagnose.** Error unwrapping now preserves useful cause-chain detail for safe-fetch and integration failures without weakening the existing outbound request guards.

### Fixed

- **Protected pages refresh auth before server rendering.** The web proxy now performs an auth preflight for protected routes so a valid session with an expired access cookie can refresh before SSR data fetches run.
- **Date formatting hydration mismatches were removed** across audit, backup, export, integration, security, ticket, article, asset, password, profile, session, expiration, and layout views.

### Security

- **MFA lockouts are scoped per user.** MFA verification now uses a dedicated per-user lockout path so shared IPs or email buckets cannot accidentally lock unrelated users out of second-factor verification.
- **Upload restore metadata no longer exposes storage keys.** The restore-info endpoint excludes internal storage keys; path disclosure moved behind a separate SUPER_ADMIN-only, audited reveal endpoint.
- **Restricted credential access is enforced consistently.** Restricted passwords now apply the internal allow-list to version listing, historical reveal, TOTP generation, API list operations, and password detail rendering. The UI now distinguishes restricted access from missing records.

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

[Unreleased]: https://github.com/Weavestream/Weavestream/compare/v1.9.3...HEAD
[1.9.3]: https://github.com/Weavestream/Weavestream/releases/tag/v1.9.3
[1.9.2]: https://github.com/Weavestream/Weavestream/releases/tag/v1.9.2
[1.9.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.9.1
[1.9.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.9.0
[1.8.15]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.15
[1.8.14]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.14
[1.8.13]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.13
[1.8.12]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.12
[1.8.11]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.11
[1.8.10]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.10
[1.8.9]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.9
[1.8.8]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.8
[1.8.7]: https://github.com/Weavestream/Weavestream/releases/tag/v1.8.7
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
