# Task 3 report — native resource DAG execution

## Outcome

Replaced the asset-specific sync path with one registry-dispatched resource page runner and one whole-DAG BullMQ job per company mapping. The implementation preserves legacy Action1, NinjaOne, and UniFi payloads through a legacy-to-asset adapter while supporting typed native reconstruction inputs.

## TDD evidence

- Initial RED: API required pattern failed 7 new assertions because page validation and DAG staging did not exist; worker explicit specs failed because actor propagation and dependency skip outcomes did not exist.
- Review-driven RED: 3 API and 1 worker assertions failed for retry replacement, native rollback, fresh traversal snapshots, and BullMQ retry propagation.
- Natural-key RED: the asset integration writer created a duplicate when two unbound candidates matched; it now returns bounded ambiguity.
- Final GREEN on Node `v24.18.0`: 19 affected API suites / 304 tests and all 5 worker suites / 29 tests.

## Implemented

- Strict legacy/typed `DriverRecord` union, bounded page protocol validation, canonical dates, snapshot/schema stability, retryable blocked-input handling, and monotonic snapshot-bounded source high-water validation.
- Generic writer-registry dispatch with exact typed identity, legacy mapping/transforms, namespaced binding migration, synthesized Breeze provenance, legacy NUL sanitization, and bounded page-local outcomes. Dry-run legacy migration executes transaction-locally and is forced to roll back with a private sentinel, so the real native ownership verifier sees the canonical binding without any committed write.
- One transaction per page containing native target mutation/audit, binding mutation, and checkpoint mutation. Hard failures roll the page back; dry runs persist none of those writes.
- Mode-specific checkpoint migration `0056` with existing rows migrated to `incremental`, cursor/snapshot resume, terminal high-water/full completion, and fresh traversal snapshots after completed cursors.
- Resource registry/readiness validation for writer availability, native target config, dependencies, cycles, and binding-resource declarations.
- One mapping job containing all ready resource IDs, topological stages executed sequentially per mapping, visible downstream skips, and concurrent isolation across company mappings.
- Manual/scheduled audit actor propagation, old-payload fallback to `Integration.createdBy`, and fail-closed missing/unauthorized actor behavior.
- Attempt-aware retries: nonfinal hard failures do not finalize results; final returned failures merge and close once; unexpected final-attempt exceptions use `failMappingJob` so mappings cannot remain running.
- Retry-idempotent per-resource status/totals/conflicts/errors; aggregate totals are re-derived from replacement entries instead of additive replay.
- Native services and writers join the caller page transaction instead of opening nested transactions.

## Review

Independent read-only review initially found retry/finalization, high-water, legacy provenance, dry-run migration, and actor fallback gaps. All Critical and Important findings were fixed and regression-tested; the final reviewer verdict was **Approved**. The dependency-skip finding was rejected after inspection: only the topo-sort copy filters unavailable keys; execution maps back to the original resource rows and therefore retains missing/disabled dependencies for visible skips.

The suggestion to add `schemaVersion` to the checkpoint schema was intentionally rejected. The resolved contract defines schema version as traversal/run metadata, not checkpoint state; the runner enforces stability within a traversal, resumes only with a committed snapshot/cursor, and relies on signed driver cursors/schema allowlists across retries.

Single unbound manual asset candidates remain unclaimed by design to preserve Task 2's persisted-ownership security contract. Multiple natural-key candidates now produce a bounded ambiguity instead of a duplicate.

## Verification

- Node 24 shared, DB, API, and worker typechecks: passed.
- Focused ESLint across changed API/worker paths: passed.
- Prisma generate and validate: passed.
- `git diff --check`: passed.
- Affected API: 19 suites, 304 tests passed.
- Worker: 5 suites, 29 tests passed.
- Broad API (excluding the known help-index baseline and isolated upload suite): 109 passed, 1 skipped; 1,296 passed, 3 skipped. The upload suite passed alone, 74/74.
- Known unchanged baseline: `app-help.service.spec.ts` remains 3 failed / 26 passed due stale guide-ranking expectations.
