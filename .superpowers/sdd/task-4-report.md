# Task 4 report — Breeze reconstruction driver

## Outcome

Added a registered Breeze pull driver backed by the guarded Partner API transport, explicit strict schemas, curated transforms for all twelve destination-oriented resources, safe blocked-input gaps, deterministic recommended site/device destinations, and generic idempotent destination bootstrap. Formal-review hardening now also prevents credential-bearing redirects, persists source revision/fingerprint as provenance, rejects traversal cursor cycles and high-water regression, enforces strict source timestamp bounds/order, and makes destination bootstrap fully transactional. The Breeze documentation logo is reused byte-for-byte.

## TDD evidence

- Initial RED on Node `v24.18.0`: the three adjacent client/driver/service suites failed as intended because `breeze-partner-api.client.ts`, `breeze.driver.ts`, and `ensureResourceDestination` did not exist. Result: 3 failed suites; 3 failed and 2 passed tests.
- First GREEN attempt: API typecheck passed and 42/44 focused assertions passed. The two failures exposed the need to separate complete shared-layout fields from per-resource mapping ownership, plus one incorrect test fixture that reported fields as pre-existing.
- Review-driven RED: cross-organization blocked metadata resolved instead of rejecting; the new assertion failed 1/23 driver tests before the boundary check was added.
- Final focused GREEN: 3/3 suites and 53/53 tests passed.
- Final affected GREEN: 10/10 suites and 178/178 tests passed, covering every integration driver plus generic runner, sync, schema, service, and reconstruction readiness paths.
- Formal-review RED on Node `v24.18.0`: 4 failed suites; 14 failed / 66 passed assertions. The failures covered cross-origin redirects, future/equal/out-of-order timestamps, nonterminal high-water, traversal cursor/high-water regression, missing reconstruction provenance, bootstrap races, inactive layouts, and rollback.
- First formal-review GREEN: 79/80 assertions passed. The only remaining failure was an obsolete test fixture that returned the old pre-create empty field read; the transactional implementation correctly reads fields only after creation.
- Final formal-review GREEN: 4/4 focused suites and 80/80 assertions passed; the broader integration run passed 19/19 suites and 297/297 assertions.

## Implemented

- Exact foundational organization/site/device DTO allowlists from the adjacent Breeze Partner API, strict version-1 envelopes, bounded cursors/data/blocked metadata, and explicit bounded future-resource schemas.
- Safe base URL normalization and endpoint allowlisting; credentials in URL userinfo/query/hash reject before network I/O. `apiKey` is sent only as `X-API-Key` through `fetchWithRetry`/`safeFetch`. Breeze requests use manual redirect handling, so a 3xx is sanitized as a failed response and the key is never forwarded to another origin.
- Sanitized auth/rate-limit/5xx/network/timeout/malformed/schema failures, including preserved `Retry-After`, stable snapshots, non-advancing/repeated cursors, organization de-duplication, and the 1,000-page traversal cap.
- Raw identity/control metadata is strictly parsed before NUL cleanup. Only already-allowlisted text is recursively NUL-stripped, then re-parsed. NUL-corrupted UUIDs reject.
- Curated asset projections for sites, devices, inventory, software, and custom fields; typed native inputs for subnet, IP reservation, article, and relation resources. No raw payload or monitoring/live-state field is passed downstream.
- Safe `secret_blocked` gaps retain only bounded source identity, reason, and safe field paths. Cross-organization or wrong-resource blocked metadata rejects.
- Every record must be at or before the traversal snapshot; incremental records must be strictly newer than `updatedSince` and page timestamps must be nondecreasing. Incremental pages emit their maximum source timestamp, the generic runner retains the traversal maximum in local traversal state for validation, and any page-level high-water regression fails before that page transaction. Nonterminal checkpoints retain only the previously committed high-water; the traversal maximum advances the checkpoint only on terminal completion. Full traversal emits no Breeze incremental high-water.
- Generic traversal-local cursor tracking is seeded from a resumed cursor and rejects multi-hop cycles before fetching or committing the repeated cursor. The 1,000-page cap remains a secondary bound.
- Legacy driver records may provide bounded optional source revision/fingerprint metadata. The generic runner promotes it into reconstruction source identity, and the native writer persists it in integration provenance without weakening typed record identity.
- Exact descriptor resources, target configs, dependencies, `bindingResourceKey` declarations, pull/list-org/dry-run capabilities, static asset catalogs, and registry entry.
- Generic `ensureResourceDestination` creates the layout and exact field set, claims the untouched resource, and creates mappings inside one production transaction. New-field creation does not skip duplicates, and an incomplete post-create field set throws so the layout rolls back. Existing layouts are read-only and reused only when active, nonarchived, complete, and type-compatible. Partial/incompatible/inactive/customized destinations remain untouched. A P2002 race retries the whole transaction once to observe the committed winner; other failures roll back the new layout and fields.
- Strict driver persistence-boundary validation for Breeze's exact `{ baseUrl }` config and `{ apiKey }` secret bundles.
- Byte-identical Breeze SVG at `apps/web/public/integrations/drivers/breeze.svg`.

## Verification

All commands used Node `v24.18.0` through `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.

- RED:
  - `pnpm --filter @weavestream/api test -- --runInBand src/integrations/drivers/breeze/breeze-partner-api.client.spec.ts src/integrations/drivers/breeze/breeze.driver.spec.ts src/integrations/integrations.service.spec.ts`
  - 3 failed suites; 3 failed / 2 passed tests.
- Focused GREEN:
  - `pnpm --filter @weavestream/api test -- --runInBand src/integrations/drivers/breeze/breeze-partner-api.client.spec.ts src/integrations/drivers/breeze/breeze.driver.spec.ts src/integrations/integrations.service.spec.ts`
  - 3 suites, 53 tests passed.
- Final affected driver/runner/readiness:
  - `NODE_OPTIONS=--experimental-vm-modules pnpm --filter @weavestream/api exec jest --runInBand src/integrations/drivers src/integrations/integration-sync-runner.service.spec.ts src/integrations/integration-sync.service.spec.ts src/integrations/integration-schemas.spec.ts src/integrations/integrations.service.spec.ts src/integrations/reconstruction/reconstruction-target.spec.ts`
  - 10 suites, 178 tests passed.
- Formal-review RED:
  - `NODE_OPTIONS=--experimental-vm-modules pnpm --filter @weavestream/api exec jest --runInBand src/integrations/drivers/breeze/breeze-partner-api.client.spec.ts src/integrations/drivers/breeze/breeze.driver.spec.ts src/integrations/integration-sync-runner.service.spec.ts src/integrations/integrations.service.spec.ts`
  - 4 failed suites; 14 failed / 66 passed tests.
- Formal-review focused GREEN:
  - Same four-suite command.
  - 4 suites, 80 tests passed.
- Formal-review broader integration GREEN:
  - `NODE_OPTIONS=--experimental-vm-modules pnpm --filter @weavestream/api exec jest --runInBand src/integrations`
  - 19 suites, 297 tests passed.
- Formal-review typecheck and lint:
  - `pnpm --filter @weavestream/api typecheck`
  - `pnpm --filter @weavestream/api exec eslint <all changed integration TypeScript files>`
  - Both passed with zero warnings/errors.
- Typechecks:
  - `pnpm --filter @weavestream/shared typecheck`
  - `pnpm --filter @weavestream/api typecheck`
  - Both passed.
- Focused lint:
  - `pnpm --dir apps/api exec eslint 'src/integrations/drivers/breeze/*.ts' src/integrations/drivers/integration-driver.ts src/integrations/drivers/integration-driver.registry.ts src/integrations/integrations.service.ts src/integrations/integrations.service.spec.ts`
  - Passed with zero warnings/errors.
- Broad API remainder:
  - `NODE_OPTIONS=--experimental-vm-modules pnpm --filter @weavestream/api exec jest --runInBand --testPathIgnorePatterns='app-help.service.spec.ts|uploads.service.spec.ts'`
  - 111 suites passed, 1 skipped; 1,356 tests passed, 3 skipped.
- Isolated upload baseline:
  - `NODE_OPTIONS=--experimental-vm-modules pnpm --filter @weavestream/api exec jest --runInBand src/uploads/uploads.service.spec.ts`
  - 1 suite, 74 tests passed.
- Known help-index baseline:
  - `NODE_OPTIONS=--experimental-vm-modules pnpm --filter @weavestream/api exec jest --runInBand src/ai-help/app-help.service.spec.ts`
  - Unchanged: 3 failed / 26 passed due stale guide-ranking expectations.
- `cmp -s` against the adjacent Breeze logo and `git diff --check`: passed.
- Prisma schema/migrations were not changed, so Prisma validation was not required.

## Broad-suite baseline

The first full API co-run excluding only `app-help.service.spec.ts` reproduced Task 3's documented Jest VM dynamic-import interaction in `uploads.service.spec.ts`: 111 suites passed, 1 skipped; 1,425 tests passed, 3 skipped; 5 upload tests failed. The upload suite then passed alone 74/74, and the broad remainder passed with the counts above. No baseline was modified or suppressed.

## Self-review and remaining concerns

- Foundational sites/devices match the current adjacent contract. Future endpoint schemas are intentionally explicit approved fixtures until those adjacent routes land; Tasks 6 and 7 may extend these allowlists and transforms but must retain fail-closed parsing.
- Asset records retain bounded curated revision/fingerprint fields and now also promote the same bounded metadata through the optional legacy provenance contract. Typed reconstruction identity remains unchanged.
- Detailed inventory/topology normalization and rebuild-complete article rendering remain Tasks 6 and 7. Task 4 supplies safe, bounded transforms for every advertised resource without raw pass-through.
- No Breeze-specific controller, SSRF bypass, raw fetch, raw-payload persistence, monitoring-state copy, or adjacent-repository mutation was introduced.
