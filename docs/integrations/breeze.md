---
label: Breeze Reconstruction Sync
icon: plug
description: Configure and operate the read-only Breeze reconstruction integration.
---

# Breeze reconstruction sync

The built-in Breeze integration copies durable, non-secret reconstruction facts into native Weavestream records. It is a read-only Partner API consumer: it does not install an agent, copy monitoring state, run commands, or write back to Breeze. The resulting company data, export, and PDF remain usable when Breeze is offline.

## Prerequisites

In Breeze, create a partner service principal for Weavestream. Human JWTs and ordinary organization API keys do not authenticate to the Partner API. For complete reconstruction, grant exactly these read scopes:

| Scope | Data used by Weavestream |
|---|---|
| `organizations:read` | Organization discovery and mapping |
| `sites:read` | Sites |
| `devices:read` | Durable device identity |
| `inventory:read` | Inventory, software, network facts, virtual machines, and relationships |
| `configuration:read` | Policies, assignments, and automations |
| `scripts:read` | Rebuild-safe scripts |
| `backup-configuration:read` | Backup schedules, retention, exclusions, and documented restore capabilities |
| `custom-fields:read` | Custom-field definitions and values |

A deliberately narrower integration may omit a scope only when every resource that requires it will remain disabled. No listed scope permits remote access, command execution, secret reads, user management, or administrative writes.

Use the public Breeze origin as **Breeze URL**, for example `https://breeze.example.com`. Do not add credentials, query parameters, fragments, or `/api/v1/partner-api` to the value. Weavestream validates and appends the allowlisted Partner API paths and sends the key only in `X-API-Key`; redirects do not receive the key.

### Private Breeze deployments

Outbound integration requests use Weavestream's SSRF and DNS-rebinding guard. Private, loopback, link-local, metadata, multicast, and other non-public destinations are blocked by default. If Breeze is intentionally private, add only its required network ranges to `EGRESS_ALLOWED_PRIVATE_CIDRS`, restart the API and worker, and test the connection. Never disable the guard broadly. DNS is resolved and pinned for each request, and a redirect is revalidated rather than treated as an allowlist bypass.

An optional source CIDR allowlist also exists on the Breeze service principal. Configure it only after Breeze's trusted-proxy/client-IP boundary is correct and tested; otherwise valid Weavestream requests will fail closed.

## Create the connection

1. In Breeze **Settings → Service Principals**, create the read-only principal and issue a key. Capture the `brz_sp_...` plaintext once.
2. In Weavestream, open **Admin → Integrations → New Integration**, choose **Breeze RMM**, enter **Breeze URL** and the one-time key, and save.
3. Select **Test connection**. A `401` means the key, expiry, revocation, principal status, partner status, or source CIDR needs correction. A `403` means an enabled resource lacks its exact read scope.
4. Open **Organizations**. Weavestream lists every organization visible to the principal. Map each source organization UUID explicitly to one Weavestream company and enable the mapping.
5. Leave unwanted organizations unmapped. Discovery alone never writes tenant data. One source organization maps to at most the company the operator explicitly selected; names are display labels, not identity.

Weavestream encrypts the Partner API key at rest with the kid-tagged `INTEGRATION_SECRET_KEY` envelope. The masked credential is never refilled as plaintext. Keep the current key and any `INTEGRATION_PREVIOUS_KEYS` needed to decrypt existing ciphertext in the deployment's secret manager, not in source control, logs, exports, or support tickets.

## Resources and ordering

Enabled resources execute as an acyclic dependency graph. Weavestream rejects cycles and does not run a child before its configured parents.

| Native target | Breeze resources and dependencies |
|---|---|
| Assets | Sites first; devices depend on sites. Site/device inventory, software, network equipment, and virtual machines enrich stable assets. Scalar custom-field values depend on devices and definitions and update their explicitly bound device without changing the value row's source identity. Warranty and support dates use expiry-marked date fields. |
| IPAM | Subnets depend on site/device inventory. IP reservations depend on subnets and device inventory. |
| Versioned internal articles | Configuration policies; assignments after policies; scripts; automations after scripts; backup configurations; custom-field definitions. The article body contains available reconstruction facts and explicitly identifies unavailable facts instead of inventing them. |
| Relations | Assignment, automation, backup, and device/topology edges run only after their endpoint resources. Missing or cross-company endpoints become safe gaps. |

Recommended destinations store bounded structured fields, not entire upstream records. Devices may include durable hardware, operating-system, firmware, disk, interface, software, warranty, virtualization, and selected custom facts. Online/offline state, heartbeat/last-seen telemetry, health, alerts, patch posture, vulnerabilities, agent tokens, commands, remote-access state, runtime output, and job logs are excluded.

Custom-field definitions and values have independent cursors. `/custom-fields` returns definition metadata only. `/custom-field-values` returns one bounded scalar row with a stable value UUID plus `orgId`, `deviceId`, `definitionId`, and an explicit device target. Weavestream walks both endpoints through every page, uses the supplied value UUID for provenance and idempotence, and uses the separate device reference only to resolve the native asset. It never rebuilds value identity from a definition/device pair or expects an embedded `values` array.

### Ownership rules

- **Source wins** updates a field from Breeze.
- **Preserve manual** accepts Breeze until an operator changes the local value, then retains the operator value.
- **Manual only** is never written by sync.

Only an exact Breeze-owned binding for the same integration, organization mapping, resource, company, target kind, and native target may mutate that target. Sync cannot claim a manual or differently owned target. Manual assets, fields, notes, uploads, articles, relations, folders, and password references are not deleted or overwritten. Password values are never requested from Breeze or decrypted for reconstruction.

## Run modes and scheduling

- **Dry run** fetches, validates, transforms, and reports outcomes but rolls back native targets, bindings, audits, gaps, and checkpoints.
- **Incremental** starts from the last committed high-water checkpoint and applies changed source records.
- **Full** traverses the complete source snapshot. Only a terminal, authoritative full traversal may mark unseen exact Breeze-owned bindings stale.

A blank integration schedule inherits `INTEGRATION_SYNC_DEFAULT_CRON`, which defaults to `*/15 * * * *` (every 15 minutes). Set an explicit five-field UTC cron for a different interval, or set the global default to `off` for manual-only blank schedules. Manual runs can select incremental or full mode.

Scheduled delivery uses a stable delivery key so a repeated scheduler delivery does not create a duplicate run. If every enabled mapping/resource scope has a successful full checkpoint from the preceding 24 hours, the scheduler selects incremental; otherwise it selects full. At most one full run per integration may be queued or running, and a racing full request falls back to incremental. Do not launch overlapping runs to evade a provider rate limit.

Each page commits its native writes, audit rows, bindings, safe gaps, and checkpoint atomically. A crash resumes from the last committed opaque cursor. Cancellation, an incomplete page walk, rejected schema, invalid cursor, exhausted retry, or a `validation`, `missing_dependency`, or `synchronization_error` gap leaves the traversal non-authoritative: last-known-good data stays in place, no absent gaps resolve, and no stale sweep occurs. A safe, explicit `secret_blocked`, `unsupported`, or `ambiguous` observation does not by itself make an otherwise complete traversal non-authoritative; the observation remains visible in completeness for operator action.

Scheduled writes are attributed to the user who created the integration when no manual trigger actor exists. If no authorized audit actor is available, the resource fails closed as `missing_audit_actor` before a native writer runs.

## Retries, limits, and checkpoints

Weavestream honors `Retry-After` for `429`, retries transient `5xx` and timeouts with bounded exponential backoff, and stops immediately on authentication/authorization and invalid-contract failures. Defaults are a 30-second request timeout, 5 retry attempts, and a 1-second backoff base; configure them with `INTEGRATION_HTTP_TIMEOUT_MS`, `INTEGRATION_HTTP_MAX_RETRIES`, and `INTEGRATION_HTTP_BACKOFF_MS`.

Operational bounds are deliberate:

| Limit | Bound |
|---|---:|
| Partner API page requested from Breeze | 500 source rows |
| Transformed records accepted in one runner page | 10,000 |
| Pages in one traversal | 1,000 |
| Safe gaps retained from one page | 1,000 |
| Run conflicts retained | 10,000 |
| Native stale/archive mutation batch | 500 |

Opaque Breeze cursors bind the resource, filters, mode, and snapshot and expire after 24 hours. Weavestream requires a stable `schemaVersion` and snapshot across pages, rejects cursor cycles and high-water regression, and advances completion/high-water only after a successful authoritative terminal page.

## Completeness, stale records, and audits

The reconstruction view reports six separate states:

| State | Meaning and operator action |
|---|---|
| Synchronized current | Current Breeze-owned native evidence exists. |
| Manually documented | Required local evidence is supplied and manually owned. Protect it during mapping changes. |
| Secret blocked | Breeze withheld a definition or Weavestream rejected it because secret-like material was detected. Document the fact safely; never paste the rejected value into a gap. |
| Missing | A required fact or dependency is absent. Restore the source endpoint/mapping or document it manually. |
| Stale | A complete full traversal no longer saw the binding. Confirm the source deletion; last-known native/manual history is retained. |
| Synchronization error | A transport, schema, validation, or write failure prevented current evidence. Correct the failure and rerun. |

Staling preserves target IDs, provenance dates, checksums, manual content, and history. Assets, articles, and subnets owned only by stale Breeze bindings are soft-archived; reservations and relations are retained. A returned source record reuses and restores its original target, clears `staleSince`, and becomes active. Repeated successful runs are idempotent.

Lifecycle audit rows use exactly `integration.target.created`, `integration.target.updated`, `integration.target.stale`, `integration.target.restored`, and `integration.target.blocked`. Their payloads contain local integration/mapping/resource/target identity, target kind/state, bounded safe counts, and an optional safe reason category only. External IDs, raw source/provenance/configuration, content, gap details, rejected values, credentials, and secrets are excluded.

## Export and offline recovery

Ordinary company export and PDF include native assets, IPAM, readable topology, reconstruction articles, safe completeness gaps, and local source-state dates. The dossier uses local labels and contains the essential procedure text; it is not a collection of Breeze links. Raw provider payloads, provenance, provider configuration, rejected values, and secret-derived content are excluded. An operator-mapped Breeze ID field is ordinary native asset data and can therefore appear in export. Passwords remain controlled by the export's existing explicit `includePasswords` option; Breeze never changes that setting.

Back up the PostgreSQL database and the deployment secret material required to decrypt integration credentials. Database state includes the integration, encrypted credential blob, explicit mappings, resource/field configuration, sync runs, bindings/provenance, checkpoints, safe gaps/summaries, native content, and audit history. Redis queue state is operational rather than the authority for committed reconstruction data. Use the normal Weavestream backup/restore process; do not copy selected integration tables independently because their company/resource/target foreign keys form one consistency boundary.

After restoring Weavestream:

1. Restore the matching `INTEGRATION_SECRET_KEY`/key ring before starting sync workers.
2. Verify companies, mappings, native targets, run history, and checkpoint rows are present.
3. Test the Breeze connection.
4. Run a dry-run full traversal and review completeness/gaps.
5. Run a real full traversal. Do not treat records missing from a failed or partial recovery crawl as deleted.
6. Verify a company export/PDF before resuming the normal schedule.

## Recovery playbooks

### Credential failure or suspected compromise

For overlap rotation, issue a second Breeze key, replace the encrypted key in Weavestream, test it, complete an authenticated traversal, then revoke the predecessor. Breeze's atomic **Rotate** operation revokes the old key immediately and should be used only for a coordinated cutover. If compromise is suspected, revoke the exposed key first, issue/install a replacement, review both systems' sanitized audits, and perform a full traversal. A failed credential test never clears checkpoints or marks data stale.

If the Weavestream integration ciphertext cannot be decrypted after restore, recover the matching integration encryption key ring. If that material is unavailable, issue a new Breeze key and update the integration; Breeze cannot recover old service-principal plaintext because it stores only a digest.

### Schema, cursor, or malformed-page failure

Pause the schedule if failures repeat. Preserve the failed run and gap evidence, confirm Breeze still returns schema version `1`, and upgrade whichever side owns the contract change. Never edit an opaque cursor or force the old checkpoint forward. After the contract is compatible, run a full dry run followed by a real full traversal. Unknown schema, malformed JSON, repeated cursor, invalid identity, or cross-company data fails before the affected page writes.

### Rate limiting, timeout, or provider outage

Honor `Retry-After`, reduce schedule/concurrency pressure if needed, and wait for the next retry or manual run. Do not create parallel traversals. The last committed cursor and local dossier remain valid. Once service returns, use incremental unless a full checkpoint is missing/expired or an operator needs disappearance reconciliation.

### Missing dependency or blocked definition

Check that every prerequisite resource is enabled and stage-ordered, both relation endpoints are mapped to the same company, and the service principal has the exact read scope. A missing dependency creates a safe gap instead of a dangling or cross-company relation. A secret-blocked item must be rewritten at its source to contain only durable non-secret reconstruction facts, then rerun; Weavestream does not offer a bypass that stores the rejected value.
