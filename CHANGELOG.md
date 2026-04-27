# Changelog

All notable changes to Weavestream are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.0] - 2026-04-27

### Changed

- **RBAC simplified to three orthogonal axes.** `Membership.role` is now
  `FULL` or `READONLY` (down from four legacy variants). Per-user
  defaults move to `User.globalAccess` (`FULL` / `READONLY` / `NONE`)
  for operators, and platform-admin tasks are delegated through a new
  `User.platformCapabilities` array (`COMPANY_MANAGE`,
  `INTEGRATION_MANAGE`, `LAYOUT_MANAGE`, `USER_MANAGE`,
  `MEMBERSHIP_MANAGE`, `AUDIT_READ`, `SETTINGS_MANAGE`,
  `EXPORT_CREATE`). `SUPER_ADMIN` retains every capability implicitly;
  this enables a "senior operator" tier without handing out super-admin.
  See `docs/ARCHITECTURE.md` for the full resolution order.
- **All admin and portal screens re-audited.** Sidebar entries, action
  buttons, and route guards now derive from `hasCapability`,
  `canWriteCompany`, and `canAccessAdminShell` helpers instead of
  ad-hoc role comparisons.
- **Updated global tags.** Global tags were refreshed and updated across
  the platform.

## [1.2.1] - 2026-04-26

### Fixed

- **Missing S3 SDK runtime dependency.** Added the missing AWS S3 SDK
  runtime package required in production so S3-backed features no longer
  fail at runtime due to missing module resolution.

## [1.2.0] - 2026-04-26

### Added

- **Articles can be authored as Markdown or Tiptap (per-article).**
  Storage uses `editor_mode` plus either Tiptap JSON (`content`) or raw
  Markdown (`markdown_source`); search continues to index
  `content_plaintext` for both. The admin article form includes a format
  toggle; switching formats on an existing article runs a one-time
  conversion with a confirmation dialog.
- **Vault records can now be exported to PDF.** Admin users can generate
  PDF exports directly from the vault workflow for sharing and archival.
- **Foundation for integration services is now in place.** Core sync
  orchestration and shared integration plumbing were introduced to
  support provider-specific connectors.
- **Action1 integration was added.** The first integration driver is now
  implemented on top of the new integration services foundation.

### Fixed

- **API JSON body limit raised to 2 MB.** Express's default 100 KB cap
  rejected legitimate article payloads - most visibly when converting a
  larger Markdown article to Tiptap, since the JSON representation
  expands past the threshold. The new limit comfortably covers the
  500 KB `MAX_MARKDOWN_SOURCE` ceiling and its Tiptap projection while
  staying bounded against unbounded payloads.
- **Format switches no longer autosave.** Switching between Markdown
  and WYSIWYG is a deliberate, potentially-lossy conversion, so the
  form now waits for an explicit Save click rather than persisting the
  converted body 4 s later. The "unsaved" tag still appears, and any
  subsequent normal edit re-arms the autosave debounce.
- **Tiptap -> Markdown table conversion no longer drops to raw HTML.**
  Tables without a `<th>` row are now promoted to a header row before
  Turndown sees them (GFM Markdown requires one), and `<p>` wrappers
  inside cells are unwrapped - joined with `<br>` for multi-paragraph
  cells - so the output is a clean GFM table instead of leaking the
  original `<table>` markup.

## [1.1.5] - 2026-04-24

### Added

- **Starred items now cover passwords, assets, and articles in addition
  to companies.** Operators can star or unstar each supported record
  from its detail page, then reopen it from the admin dashboard or the
  new sidebar starred drawer with type-specific icons, tenant context,
  archived-state labels, and direct links.
- **Per-user star storage now exists for every supported entity type.**
  New Prisma models and migration tables track starred passwords,
  assets, and articles with user/entity uniqueness and cascade cleanup.
  The `/me/stars` API now returns a single mixed list and exposes
  idempotent star/unstar routes for companies, passwords, assets, and
  articles.

### Fixed

- **Unauthenticated visits to `/` no longer emit a large RSC redirect
  body.** Next.js now handles the missing-session redirect to `/login`
  at the routing layer, avoiding noisy "Big Redirect" findings while
  preserving authenticated role-based routing.
- **Next.js static assets now ship minimal security headers.** The
  `/_next/static/*` tree gets `X-Content-Type-Options: nosniff` and a
  restrictive `Content-Security-Policy` even though the edge proxy skips
  Next internals for HMR compatibility.

## [1.1.4] - 2026-04-23

### Changed

- **Node.js 24 is now the minimum supported runtime.** Node 20
  maintenance LTS reaches end of life on 2026-04-30. All Docker images
  (`api`, `web`, `worker`) now build on `node:24-alpine`, `engines.node`
  is `>=24.0.0`, and CI runs on Node 24. `@types/node` is pinned to
  `^24.0.0` across the workspace. Self-hosted deployments should
  confirm their host runtime is on Node 24 before upgrading.
- **pnpm 10 is now the workspace package manager.** `packageManager`
  in root `package.json` is pinned to `pnpm@10.33.2` and CI runs the
  same version. pnpm 10 no longer runs install scripts by default; the
  allow-list is declared in `pnpm.onlyBuiltDependencies` (prisma,
  @prisma/client, @prisma/engines, @nestjs/core, argon2, sharp,
  msgpackr-extract, unrs-resolver). Contributors should run
  `corepack enable` once; subsequent `pnpm` invocations inside the
  repo will auto-use the declared version.
- **TypeScript, Jest, and ts-jest bumped to the latest 5.x / 30 lines.**
  TypeScript 5.6 -> 5.9, Jest 29 -> 30.3, `@types/jest` 29 -> 30,
  ts-jest floor raised to 29.4.9 (still the latest; ts-jest has not
  cut a v30 but its 29.4.x line is officially compatible with Jest 30).
  No test or jest config changes were required. A separate future PR
  will handle the TypeScript 5.x -> 6.x jump, which has real breaking
  changes (new `strict` / `types` / `rootDir` defaults).
- **Zod floor raised from `^3.23.8` to `^3.25.0`.** Resolves to
  `zod@3.25.76`, the latest of the actively-maintained 3.x line. That
  version also ships the Zod 4 preview under `zod/v4`, so individual
  schemas can migrate incrementally. A full workspace-wide bump to
  Zod 4.x is deferred: v4.3.x has a known `z.enum` overload-resolution
  regression that pollutes the inferred enum output with
  `Array.prototype` members whenever the input is an array literal,
  forcing every `z.enum(...)` call site to either use object form or
  explicit casts — that's a dedicated PR and probably a wait for
  upstream to fix the inference bug.

### Fixed

- **Release workflow no longer hangs for 40+ minutes on worker
  `linux/arm64`.** The previous single-job matrix built both
  architectures on an `amd64` runner using QEMU emulation, and the
  worker's pnpm install reliably crashed under qemu with
  `qemu: uncaught target signal 4 (Illegal instruction)`. The release
  pipeline now builds each architecture on its native runner
  (`ubuntu-24.04` for `amd64`, `ubuntu-24.04-arm` for `arm64`) and a
  subsequent `manifest` job stitches them into a multi-arch image —
  no more emulation, and worker builds complete in minutes.
- **pnpm 10 prod-prune step failed inside Docker with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.** pnpm 10 added a
  safety rail that refuses to remove/recreate `node_modules`
  non-interactively unless it detects it's running in CI. GitHub
  Actions sets `CI=true` on the runner host, but Docker `RUN` steps
  don't inherit host env vars. The api/worker Dockerfiles now prefix
  the prune step with `CI=true` so the runtime image can be built
  correctly.

### Deferred (for future PRs)

- **Prisma 5 -> 6+.** Prisma 6 removes the `$use` middleware hook in
  favour of Client Extensions (`$extends`). Our `PrismaService`
  middleware enforces tenant isolation on every query — security-
  critical code that deserves its own dedicated migration PR with
  focused review (the refactor either returns a replacement instance
  from the constructor, which breaks NestJS lifecycle hooks, or
  changes the shape of `PrismaService` across ~35 consumer files).
- **TypeScript 5 -> 6.** New defaults (`strict: true`,
  `types: []`, inferred `rootDir`) require a workspace-wide
  `tsconfig.json` audit; not a drop-in bump.
- **Zod 3.25 -> 4.x** (see above — blocked on upstream inference fix
  for `z.enum(array)`).

## [1.1.3] - 2026-04-23
### Fixed

- **Client viewers can reveal permitted client-visible passwords again.**
  `CLIENT_VIEWER` memberships are now included in `password.reveal`
  authorization, with existing visibility and restriction checks still
  enforced inside the passwords service.
- **Article excerpts no longer render twice on read pages.** The
  dedicated excerpt block was removed from both admin and portal article
  read views to avoid duplicate summary text when content already
  includes the same intro.
- **Article edit pages now expose file attachments.** The attachments
  panel is available in the article form sidebar/sheet so operators can
  manage uploads without leaving the edit flow.
- **Article browser layout now shrinks correctly in split panes.**
  Applied a missing `min-width: 0` constraint so the browser content no
  longer overflows in constrained admin layouts.
- **Password detail pages now show the linked asset name.** The page
  resolves the linked asset and labels the outbound link with the asset
  title instead of generic copy.
- **Password reveal and inline warning surfaces use valid theme tokens.**
  Updated stale CSS vars (`--bg-elev`, fallback accent colors) to
  supported tokens so warnings and reveal fields render consistently
  across themes.

## [1.1.1] - 2026-04-23

### Added

- **Asset layout rename & archive.** Global asset layouts can now be
  renamed in place and archived (soft-deleted) from the layout list,
  with a dedicated archive dialog that warns before removing a layout
  still in use by existing assets. Archived layouts stop appearing in
  the asset creation picker but remain viewable on historical assets.
- **"Other" free-text option on dropdown fields.** Asset layout
  dropdowns can opt in to an "Other…" escape hatch that lets users
  enter a one-off value without polluting the shared option list.
- **Reorderable dropdown & multiselect options.** Drag-and-drop
  reordering of option lists in the asset layout builder, so the
  option order shown to users no longer depends on creation order.
- **IP address field type.** New first-class field kind for asset
  layouts (IPv4/IPv6, optional CIDR). Lays the groundwork for the
  upcoming IPAM feature.

### Fixed

- **Text file uploads rejected as `audio/mpeg`.** UTF-16 LE's `FF FE`
  byte-order mark collides with the 11-bit MPEG frame-sync pattern
  that `file-type` sniffs for, so BOM-prefixed `.txt` files (BitLocker
  recovery keys, Notepad exports, Excel CSVs) were being rejected as
  audio on upload confirmation. Uploads now peek for UTF-8/16/32 BOMs
  before running `file-type` and short-circuit to `text/plain`.
- **429 rate limits masquerading as 404s in SSR.** The global
  throttler keyed every authenticated request on the Express socket
  peer — which in Docker is the web container's internal bridge
  address, shared by every operator. A single user refreshing a
  company page could exhaust the 100 req/min quota for the whole
  fleet, and the SSR layer would then surface the 429 as a generic
  `notFound()`. Rate limiting is now keyed on `req.user.id` (falling
  back to the real client IP once `trust proxy` is honoured), and
  `serverApiFetch` forwards 429s to a dedicated route-segment error
  panel that shows the honoured cooldown and an auto-enabling retry
  button.
- **Safari constantly prompting to save passwords.** The password
  create/edit dialog's inputs looked like a login form to Safari's
  built-in password manager, which kept interrupting admin workflows
  with "Save Password?" prompts. Tweaked input naming, autocomplete
  hints, and form semantics so Safari no longer intercepts the
  vault's own fields.

## [1.1.0] - 2026-04-22

### Added

- **Password vault.** Per-tenant password manager with envelope-encrypted
  secret, notes, and TOTP fields. Every ciphertext is stamped with a
  key id (`PASSWORD_ENCRYPTION_KEY_KID`) so keys can be rotated without
  downtime — rows written under a previous kid decrypt seamlessly via
  `PASSWORD_PREVIOUS_KEYS` and re-encrypt under the current kid on
  their next update. Version history, archive/restore, credential
  attachments (URL + username pairs), and a full reveal-audit trail
  are all first-class.
- **Password generator.** Local, offline generator with words + symbols,
  passphrase, and custom-length modes; a 200-word EFF-style wordlist
  ships with the web app. Surfaced in the create/edit password
  dialogs and reachable standalone from the secret input.
- **zxcvbn strength meter** on password entry, with realtime score,
  warning, and suggestions.
- **HaveIBeenPwned breach check.** Worker-side k-anonymity lookup
  (SHA-1 prefix only; first 5 hex chars leave the server) on every
  password create/update. Toggled by `HIBP_ENABLED` — default `true`,
  set `false` to disable the outbound request entirely.
- **Expirations tracker.** Global `/admin/expirations` and per-company
  views rolling up upcoming and past-due expiry dates across assets
  and passwords, with full-text search integration.
- **Audit log pagination.** Server-side cursor pagination with
  configurable page size and URL-sticky filters on `/admin/audit`.
- **Asset template catalog.** Reusable, per-tenant asset definitions
  with a managed catalog in the admin UI.
- **MFA QR code** rendered inline during TOTP enrollment (no more
  copy-paste of the secret).
- **`reencrypt-passwords` CLI.** `pnpm --filter @weavestream/api cli
  reencrypt-passwords [--force]` walks every Password and
  PasswordVersion blob and rewraps onto the current kid; supports
  bulk re-encryption after a key rotation or blob-format migration.

### Changed

- `prisma migrate deploy` now runs inside the `api` container on
  startup instead of as a separate one-shot `migrate` service. Prisma
  takes an advisory lock so concurrent api replicas are still safe.
  This removes the exit-0 `migrate` container that some Docker UIs
  (UGREEN, Portainer, Docker Desktop) were flagging as a project
  error.
- Persistent data now lives in bind-mounted host folders under
  `$DATA_DIR` (defaults to `./data` next to `compose.yml`) instead of
  named Docker volumes. Lets you `ls`, rsync, and back up with
  standard filesystem tools — and lets NAS users point at a specific
  share (e.g. `/volume1/docker/weavestream`) without involving Docker
  volume plumbing.
- `compose.yml` no longer hard-codes a Compose project name; the
  folder name wins, matching standard `docker compose` behaviour.
- `scripts/keygen.sh` / `scripts/keygen.ps1` now emit
  `PASSWORD_ENCRYPTION_KEY` alongside the other secrets.

### Fixed

- Sharp (`libvips`) native module on `linux/amd64` musl — removed
  `vips-dev` from the api / web base images so Sharp's prebuilt
  binaries load cleanly on both amd64 and arm64.
- Docker `web` image now builds `@weavestream/shared` before the
  Next.js build step, preventing stale types during multi-stage
  builds.

### Upgrading from 1.0.0

- Re-download `compose.yml` and `.env.example` from the `v1.1.0` tag.
- Add `PASSWORD_ENCRYPTION_KEY` (32-byte base64) and
  `PASSWORD_ENCRYPTION_KEY_KID` (e.g. `2026-01`) to your `.env`. The
  fastest path is to re-run `./scripts/keygen.sh` (or `.ps1` on
  Windows) and copy just the new `PASSWORD_ENCRYPTION_KEY` line into
  your existing `.env`.
- Optionally set `HIBP_ENABLED=false` if your deployment cannot reach
  `api.pwnedpasswords.com`.
- Add `DATA_DIR=...` to your `.env` (or accept the `./data` default).
- **Migrate existing data** from the named volumes to the new folders
  before the first `up`, otherwise the stack will boot against empty
  databases. One-liner per volume:

  ```bash
  # Run AFTER `docker compose down`, BEFORE `docker compose up -d`
  mkdir -p ./data/postgres ./data/redis ./data/minio
  docker run --rm -v weavestream_pg_data:/src -v "$PWD/data/postgres":/dst \
    alpine sh -c 'cp -a /src/. /dst/'
  docker run --rm -v weavestream_redis_data:/src -v "$PWD/data/redis":/dst \
    alpine sh -c 'cp -a /src/. /dst/'
  docker run --rm -v weavestream_minio_data:/src -v "$PWD/data/minio":/dst \
    alpine sh -c 'cp -a /src/. /dst/'
  docker volume rm weavestream_pg_data weavestream_redis_data weavestream_minio_data
  ```

- Three new Prisma migrations run automatically on the next
  `docker compose up -d`:
  - `0016_phase10_passwords`
  - `0017_phase10_passwords_search_index`
  - `0018_phase10_password_generator_defaults`

## [1.0.0] - 2026-04-21

Initial public release.

### Highlights

- Postgres-backed, Docker-first IT documentation platform.
- Tenant documentation with Tiptap-based rich-text articles, folders,
  photo galleries, and per-organization asset layouts.
- Invite-only user management with forced TOTP MFA and append-only
  audit logging across every mutation.
- Two-layer RBAC: global roles (`SUPER_ADMIN`, `OPERATOR`, `CONTRACTOR`,
  `CLIENT_USER`) combined with per-tenant memberships, all evaluated
  from a single permission matrix.
- Read-only client portal per tenant, with server-side field scoping
  via the `visibleToClients` flag.
- MinIO-compatible object storage with one bucket per tenant.
- Domain & SSL expiry monitoring.
- Full-text search across articles, assets, and uploads.
- Configurable workspace branding and tenant terminology
  (company / client / department / tenant / site / custom) from the
  admin UI without code changes.
- Mobile-responsive admin shell and client portal.

### Deployment

- Published multi-arch (`linux/amd64`, `linux/arm64`) container images
  at `ghcr.io/weavestream/weavestream-{api,web,worker}:1.0.0`.
- Turnkey `compose.yml` that pulls from GHCR — no source tree or pnpm
  required on the host.
- One-shot `migrate` service runs `prisma migrate deploy` automatically
  on every `docker compose up`.
- OS-native key generation via [`scripts/keygen.sh`](scripts/keygen.sh)
  and [`scripts/keygen.ps1`](scripts/keygen.ps1) — no Docker exec, no
  Node required to seed `.env`.

### Known limitations

- No built-in TLS termination; front with a reverse proxy.
- Single-tenant Postgres (shared schema with `companyId` scoping), not
  database-per-tenant.
- English UI only.

[Unreleased]: https://github.com/Weavestream/Weavestream/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.3.0
[1.2.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.2.1
[1.1.1]: https://github.com/Weavestream/Weavestream/releases/tag/v1.1.1
[1.1.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.1.0
[1.0.0]: https://github.com/Weavestream/Weavestream/releases/tag/v1.0.0
