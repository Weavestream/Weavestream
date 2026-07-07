# OpenWiki Plan

## Intended pages
- `openwiki/quickstart.md` — repo overview, what Weavestream is, top-level architecture, repo layout, how to start, and links to deeper docs.
  - Evidence: `README.md`, `docs/index.md`, `docs/getting-started/quickstart.md`, `compose.yml`, `package.json`.
- `openwiki/architecture.md` — runtime topology, request flow, tenant model, RBAC, storage, and major source areas.
  - Evidence: `docs/overview/architecture.md`, `compose.yml`, `packages/shared/src`, `apps/api/src`, `apps/web/src`, `apps/worker/src`.
- `openwiki/workflows.md` — operator and contributor workflows worth preserving (start, first admin, development/test/build commands, migration flow).
  - Evidence: `README.md`, `docs/getting-started/quickstart.md`, `compose.yml`, `package.json`.
- `openwiki/domain.md` — core product domains such as articles, assets, passwords, domains, IPAM, integrations, alerts, security center, chat.
  - Evidence: `apps/api/src/*`, `apps/web/src/app/admin/*`, `docs/features/*`, `docs/guides/*`.
- `openwiki/testing.md` — tests, lint/typecheck/build commands, and where specs live.
  - Evidence: `package.json`, representative `*.spec.ts` files in apps/packages.

## Remaining questions
- Whether a separate `operations.md` is needed, or if deployment/backup/upgrade guidance should stay folded into quickstart + workflows.
- Whether the repo is large enough to justify splitting domain documentation into multiple pages, or if one canonical domain page is enough for a first pass.