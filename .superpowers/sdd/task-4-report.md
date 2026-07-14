# Task 4 report — Breeze reconstruction driver

## Outcome

Added a registered Breeze pull driver backed by the guarded Partner API transport, explicit strict schemas, curated transforms for all twelve destination-oriented resources, safe blocked-input gaps, deterministic recommended site/device destinations, and generic idempotent destination bootstrap. The Breeze documentation logo is reused byte-for-byte.

## TDD evidence

- Initial RED on Node `v24.18.0`: the three adjacent client/driver/service suites failed as intended because `breeze-partner-api.client.ts`, `breeze.driver.ts`, and `ensureResourceDestination` did not exist. Result: 3 failed suites; 3 failed and 2 passed tests.
- First GREEN attempt: API typecheck passed and 42/44 focused assertions passed. The two failures exposed the need to separate complete shared-layout fields from per-resource mapping ownership, plus one incorrect test fixture that reported fields as pre-existing.
- Review-driven RED: cross-organization blocked metadata resolved instead of rejecting; the new assertion failed 1/23 driver tests before the boundary check was added.
- Final focused GREEN: 3/3 suites and 53/53 tests passed.
- Final affected GREEN: 10/10 suites and 178/178 tests passed, covering every integration driver plus generic runner, sync, schema, service, and reconstruction readiness paths.

## Implemented

- Exact foundational organization/site/device DTO allowlists from the adjacent Breeze Partner API, strict version-1 envelopes, bounded cursors/data/blocked metadata, and explicit bounded future-resource schemas.
- Safe base URL normalization and endpoint allowlisting; credentials in URL userinfo/query/hash reject before network I/O. `apiKey` is sent only as `X-API-Key` through `fetchWithRetry`/`safeFetch`.
- Sanitized auth/rate-limit/5xx/network/timeout/malformed/schema failures, including preserved `Retry-After`, stable snapshots, non-advancing/repeated cursors, organization de-duplication, and the 1,000-page traversal cap.
- Raw identity/control metadata is strictly parsed before NUL cleanup. Only already-allowlisted text is recursively NUL-stripped, then re-parsed. NUL-corrupted UUIDs reject.
- Curated asset projections for sites, devices, inventory, software, and custom fields; typed native inputs for subnet, IP reservation, article, and relation resources. No raw payload or monitoring/live-state field is passed downstream.
- Safe `secret_blocked` gaps retain only bounded source identity, reason, and safe field paths. Cross-organization or wrong-resource blocked metadata rejects.
- Incremental source high-water is the validated terminal page maximum. No process-local traversal state is retained; full traversal emits no incremental high-water.
- Exact descriptor resources, target configs, dependencies, `bindingResourceKey` declarations, pull/list-org/dry-run capabilities, static asset catalogs, and registry entry.
- Generic `ensureResourceDestination` creates deterministic global layouts/fields only for a newly created recommended layout and atomically claims untouched resources before creating initial mappings. Existing layouts are read-only and reused only when every required field exists with a compatible type. Partial/incompatible/customized destinations remain untouched. P2002 races re-read the winner without mutating its fields.
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
- Asset records keep revision/fingerprint as explicit bounded curated fields and `updatedAt` as the generic legacy timestamp. Generic provenance promotion belongs to Task 8; the Task 3 `DriverRecord` union was not weakened.
- Detailed inventory/topology normalization and rebuild-complete article rendering remain Tasks 6 and 7. Task 4 supplies safe, bounded transforms for every advertised resource without raw pass-through.
- No Breeze-specific controller, SSRF bypass, raw fetch, raw-payload persistence, monitoring-state copy, or adjacent-repository mutation was introduced.
