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
| `backup-configuration:read` | Backup schedules, retention, and exclusions |
| `custom-fields:read` | Custom-field definitions and values |

A deliberately narrower integration may omit a scope only when every resource that requires it will remain disabled. No listed scope permits remote access, command execution, secret reads, user management, or administrative writes.

Use the public Breeze origin as **Breeze URL**, for example `https://breeze.example.com`. Do not add credentials, query parameters, fragments, or `/api/v1/partner-api` to the value. Weavestream validates and appends the allowlisted Partner API paths and sends the key only in `X-API-Key`; redirects do not receive the key. The Partner API surface (`/api/v1/partner-api/...`, introduced in the July 2026 Breeze release) must exist on the deployment — on an older Breeze every partner request 404s, so upgrade Breeze first.

If you change the **Breeze URL** to a different host, enter the Partner API key again in the same save. Weavestream refuses to send a saved key to a new host.

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

Enabled resources execute as an acyclic dependency graph. Weavestream rejects cycles and does not run a child before its configured parents. A dependency sets the order only. A child always runs, also when a parent failed or is disabled. Each record whose parent is not synced becomes a `missing_dependency` gap for that record only, and the other records sync.

| Native target | Breeze resources and dependencies |
|---|---|
| Assets | Sites first; devices depend on sites. Site/device inventory, software, network equipment, and virtual machines enrich stable assets. Scalar custom-field values depend on devices and definitions and update their explicitly bound device without changing the value row's source identity. Warranty and support dates use expiry-marked date fields. |
| IPAM | Subnets depend on site/device inventory. IP reservations depend on subnets and device inventory. |
| Versioned internal articles | Configuration policies; assignments after policies; scripts; automations after scripts; backup configurations; custom-field definitions. The article body contains available reconstruction facts and explicitly identifies unavailable facts instead of inventing them. |
| Relations | Assignment, automation, backup, and device/topology edges run only after their endpoint resources. Missing or cross-company endpoints become safe gaps. |

Recommended destinations store bounded structured fields, not entire upstream records. Devices may include durable hardware, operating-system, firmware, disk, interface, software, warranty, virtualization, and selected custom facts. Online/offline state, heartbeat/last-seen telemetry, health, alerts, patch posture, vulnerabilities, agent tokens, commands, remote-access state, runtime output, and job logs are excluded.

Custom-field definitions and values have independent cursors. `/custom-fields` returns definition metadata only. `/custom-field-values` returns one bounded scalar row with a stable value UUID plus `orgId`, `deviceId`, `definitionId`, and an explicit device target. Weavestream walks both endpoints through every page, uses the supplied value UUID for provenance and idempotence, and uses the separate device reference only to resolve the native asset. It never rebuilds value identity from a definition/device pair or expects an embedded `values` array.

Scalar custom fields are opt-in. For each selected definition, configure a `custom-field-values` mapping whose source field is the immutable Breeze `definitionId` and whose target is a distinct field on the Breeze Devices layout. Each mapping carries its own ownership rule. A scalar row writes only the field mapped to its definition; unmapped definitions do not write native state. The mutable Breeze field key and name remain display metadata and are not mapping identities.

### Ownership rules

- **Source wins** updates a field from Breeze.
- **Preserve manual** accepts Breeze until an operator changes the local value, then retains the operator value.
- **Manual only** is never written by sync.

Only an exact Breeze-owned binding for the same integration, organization mapping, resource, company, target kind, and native target may mutate that target. Sync cannot claim a manual or differently owned target. Manual assets, fields, notes, uploads, articles, relations, folders, and password references are not deleted or overwritten. Password values are never requested from Breeze or decrypted for reconstruction.

## Breeze upgrades

Weavestream reads only the Breeze fields it maps to Weavestream fields, so a Breeze upgrade within the same partner API `schemaVersion` does not need a Weavestream release:

- A field Breeze adds is ignored. It is not inspected, rendered, or stored.
- A new value in a list Weavestream only displays (an OS, role, equipment type, script language, relationship type) syncs as plain text.
- A new record variant (a subject type or backup kind) or a relationship to an endpoint kind Weavestream does not model is skipped.
- A field Weavestream reads but Breeze no longer sends is read as unknown, not as empty. Weavestream remembers how often each field it reads was present in the last clean sync. When a field that was present on every record (over at least 5) is missing from every record on a page, that page writes nothing and the resource gets a **field hold** (see [Sync holds](#sync-holds)). A field that was sometimes absent before is not watched; it becomes empty as before.
- A record that Weavestream still cannot read (a field it uses has an unexpected type, a record type is missing, a list it reads holds more than 1,000 items, or nesting is too deep) is skipped with a `validation` gap that names the field paths (never the values). Weavestream never truncates such a list. The other records in the page sync. The resource is reported incomplete, so no stale sweep archives data because of that record.

A new `schemaVersion` pauses the sync. Breeze bumps it for removals, renames, and type changes. Weavestream does not read a response with a version it does not know, so it writes nothing and archives nothing. The run shows **paused** with the message "Breeze reported partner API schema version X, which Weavestream does not know yet. Sync is paused and existing data is kept.", and the integration page shows a **version hold** (see [Sync holds](#sync-holds)). Test connection reports the same message. An admin can continue with **Accept changes from Breeze RMM**.

### Breeze version on each run

At the start of each sync run, Weavestream reads the Breeze release from `GET /health` (`version`; this endpoint needs no login, so the API key is not sent) and the partner API `schemaVersion`, and saves both on the run. Open a run on the **Runs** tab to see them as **source version** and **API schema version**. When the Breeze release differs from the previous run that reported one, the run shows a **new version** tag, and the run details say "Breeze RMM version changed from X to Y since the previous run." **Test connection** also names both versions.

The read is advisory. It runs after the run has queued its work, with one 5-second try. When Breeze does not answer, sends no version, or sends a value that is not a plain version label (letters, digits, `.`, `_`, `+`, and `-`, at most 64 characters), the run shows no version and syncs as usual.

### Early warning for new Breeze releases

A scheduled GitHub Actions workflow (`.github/workflows/breeze-contract.yml`, Mondays and on demand) compares the newest Breeze release with what Weavestream reads. It fetches only the partner API source files of that release (`apps/api/src/routes/partnerApi/` and `services/versionInfo.ts`), reads them as text, and never builds or runs them. It needs no secrets and no running Breeze. The field list comes from the Breeze driver itself, so it stays in step with the driver.

The job fails when the release removes or renames a field Weavestream reads, turns a list into a single value, removes an endpoint or a record variant, or declares a new `schemaVersion`. The job summary lists each change with its endpoint and field path. A change to the `/health` version is shown as a notice and does not fail the job, because it affects only the version shown on runs. To check a specific Breeze tag, run the workflow by hand and enter the tag. To check a local Breeze checkout, run from `apps/api`:

```bash
pnpm exec tsc -p scripts/tsconfig.check-breeze-contract.json && node node_modules/.cache/breeze-contract-check/scripts/check-breeze-contract.js <path-to-breeze-checkout> --ref <tag>
```

## Run modes and scheduling

- **Dry run** fetches, validates, transforms, and reports outcomes but rolls back native targets, bindings, audits, gaps, and checkpoints.
- **Incremental** starts from the last committed high-water checkpoint and applies changed source records. The high-water mark is the traversal `snapshotAt`, which Breeze documents as the consumer checkpoint, so it does not depend on how Breeze orders records within a page. The first incremental run after a full or empty traversal has no checkpoint yet; it sends no `updatedSince` and commits the traversal `snapshotAt` so the next run is incremental.
- **Full** traverses the complete source snapshot. Only a terminal, authoritative full traversal may mark unseen exact Breeze-owned bindings stale, and only on a second miss (see [Sync holds](#sync-holds)).

A blank integration schedule inherits `INTEGRATION_SYNC_DEFAULT_CRON`, which defaults to `*/15 * * * *` (every 15 minutes). Pick an explicit interval preset in the integration's schedule dropdown for a different cadence (stored as a five-field UTC cron), or set the global default to `off` for manual-only inherited schedules. Manual runs can select incremental or full mode.

Scheduled delivery uses a stable delivery key so a repeated scheduler delivery does not create a duplicate run. If every enabled mapping/resource scope has a successful full checkpoint from the preceding 24 hours, the scheduler selects incremental; otherwise it selects full. At most one full run per integration may be queued or running, and a racing full request falls back to incremental. Do not launch overlapping runs to evade a provider rate limit.

Each page commits its native writes, audit rows, bindings, safe gaps, and checkpoint atomically. A crash resumes from the last committed opaque cursor. Cancellation, an incomplete page walk, rejected schema, invalid cursor, exhausted retry, or a `validation`, `missing_dependency`, or `synchronization_error` gap leaves the traversal non-authoritative: last-known-good data stays in place, no absent gaps resolve, and no stale sweep occurs. A walk that finishes with only record-level gaps still ends the resource as succeeded. The Runs tab shows such a run as **warnings**, and the conflict list names each record that was not written. A resource fails only when the walk itself fails: transport, authorization, a response envelope Weavestream cannot read, a cursor that does not advance or repeats, or a record or notice from a Breeze organization other than the one requested. A safe, explicit `secret_blocked`, `unsupported`, or `ambiguous` observation does not by itself make an otherwise complete traversal non-authoritative; the observation remains visible in completeness for operator action.

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

**Fail small.** A problem with one record costs that record, not the run. Weavestream skips the record with a `validation` gap (its field paths, never its values), keeps the last-known-good data, and marks the traversal non-authoritative so nothing is archived. These cases are record gaps:

- Two records with the same stable identity but different content (`conflicting_duplicate_identity`). All copies are skipped.
- Records that give one subnet different facts or gateways (`conflicting_subnet_facts`, `conflicting_subnet_gateways`). All records for that subnet are skipped.
- A record with a gateway that is not valid, or with more than one gateway for one subnet (`invalid_static_gateway`, `conflicting_subnet_gateways`).
- A record with managed-region markers Weavestream cannot read (`invalid_managed_region`), or a relationship to an endpoint kind Weavestream does not model (`unsupported_relationship_endpoint`).
- A record the transform cannot read for any other reason (`unreadable_source_record`, `record_transform_failed`).
- A Breeze "blocked" notice Weavestream cannot read, or one for a different resource (`unreadable_blocked_notice`, `blocked_notice_other_resource`).
- A gap notice from the driver that is malformed, and gap notices past the per-page limit (`invalid_blocked_input`, `gap_observation_overflow`).

Opaque Breeze cursors bind the resource, filters, mode, and snapshot and expire after 24 hours. Weavestream requires a stable `schemaVersion` and snapshot across pages, rejects cursor cycles and high-water regression, and advances completion/high-water only after a successful authoritative terminal page.

## Sync holds

Weavestream never archives or blanks synced data because of one surprising Breeze response. These rules apply to every integration that syncs through the reconstruction pipeline, not only Breeze.

**Two misses before archiving.** When a full sync does not see a record, Weavestream only notes the miss. The record is marked stale and its asset, article, or subnet is archived only when a later full sync, at least 12 hours after the first miss, also does not see it, and no sync saw it in between. A record that comes back in between starts over. The Runs tab counts records that were missed but not archived as **not seen**. Records synced before this rule existed start with no miss, so the first full sync after an upgrade archives nothing.

**Mass-removal hold.** When the second misses of one company mapping and resource are at least 3 records and at least 10% of its synced records, Weavestream archives none of them. The run shows a warning ("Breeze RMM returned far fewer … records than before. Nothing was archived."), and the integration page shows a hold.

**Field hold.** When Breeze stops sending a field that was always present (for example after a rename), the affected pages write nothing, their records count as blocked, and the run shows a warning that names the field path, never a value. No stale sweep runs for that resource. The hold clears by itself after a clean sync in which the field is back.

**Version hold.** When Breeze reports a partner API `schemaVersion` Weavestream does not know, the resource reads nothing from that response. It writes nothing and archives nothing, its cursor is reset, and the run shows **paused**. The integration page shows one **Unknown source version** hold per company with the version label (letters, digits, `.`, `_`, and `-` only, at most 32 characters; anything else shows as "no readable schema version reported"). The hold stays until a Weavestream release knows the version or an admin accepts it.

**Accepting changes.** The integration page lists every open hold (resource, company, kind, since when, and a short detail). When the change in Breeze is expected, select **Accept changes from Breeze RMM** next to **Run sync now** on the Credentials & schedule tab. The option shows only while a hold is open and needs the integration configuration permission. The run is always a full sync. It archives held records that were missed twice (the two-miss rule still applies), writes pages despite missing fields, rebuilds the field baseline from this sync, reads a response with any `schemaVersion`, and clears all holds. Weavestream stores the version it read as accepted for that company and resource, so later scheduled runs read it without a new hold. A different version later pauses again. It is audited as `integration.sync.accept_source_changes` with counts only.

## Completeness, stale records, and audits

The reconstruction view reports six separate states:

| State | Meaning and operator action |
|---|---|
| Synchronized current | Current Breeze-owned native evidence exists. |
| Manually documented | Required local evidence is supplied and manually owned. Protect it during mapping changes. |
| Secret blocked | Breeze withheld a definition, or Weavestream's final write check found secret-like material that in-place withholding did not remove. Document the fact safely; never paste the rejected value into a gap. |
| Missing | A required fact or dependency is absent. Restore the source endpoint/mapping or document it manually. |
| Stale | Two complete full traversals, at least 12 hours apart, no longer saw the binding. Confirm the source deletion; last-known native/manual history is retained. |
| Synchronization error | A transport, schema, validation, or write failure prevented current evidence. Correct the failure and rerun. |

The checklist is evaluated for every Breeze resource of every mapped company. Each capability without evidence produces one gap that starts with "Reconstruction checklist:". These gaps are documentation items, not missing Breeze data. A resource such as Device software cannot supply evidence for most capabilities, so a tenant with many resources and companies shows hundreds of checklist gaps until an operator documents each fact in a form the evaluator recognizes. Each gap message lists that form. The evaluator matches an asset field by its **slug**, never by its value, so backup instructions typed into a generic Notes field do not clear a gap. A linked article is an article related to an item this resource synced; its manually authored text must contain the listed phrase.

| Capability | Recognized evidence |
|---|---|
| Administrative credential | A credential entry on a linked asset; a field slug containing `administrative_credential` or `credential_reference`; article text "administrative credential" or "credential reference". |
| Installation source | A field slug containing `installation_source`, `install_source`, `install_media`, or `download_source`; article text "installation source", "install media", or "download source". |
| License activation | A field slug containing `license`, `activation`, or `product_key`; article text "license", "activation", or "product key". |
| Physical location | A field slug containing `physical_location`, `rack`, `room`, `site_location`, `address_line`, or `postal_code`; article text "physical location", "rack", "room", or "site location". |
| IP firewall | A field slug containing `firewall_rules` or `ip_firewall`; article text "firewall rules" or "IP firewall". |
| Backup restore | A field slug or article text containing both "backup" and "restore". |
| Service dependencies | A relation between a linked item and another item; a field slug containing `service_dependencies`, `data_dependencies`, or `depends_on`; article text "service dependencies" or "depends on". |
| Ordered rebuild steps | A field slug containing `ordered_rebuild` or `rebuild_steps`; article text "ordered rebuild", "rebuild steps", or "rebuild procedure". |
| Post restoration validation | A field slug containing `post_restoration_validation` or `validation_steps`; article text "post-restoration validation" or "validation steps". |
| Vendor escalation contact | A field slug containing `vendor_contact`, `escalation_contact`, or `support_contact`; article text "vendor contact", "escalation contact", or "support contact". |

The Secret-blocked counter in this view counts capabilities, not gaps: a withheld record only moves the counter when its source resource maps to a capability (sites, scripts, automations, backup configurations, relations, subnets, and IP reservations). The per-run "secret blocked" total on the Runs tab counts every withheld record. A record that synced with some values withheld counts under "values withheld", not "secret blocked".

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

An unknown schema version pauses the resource with a version hold; it does not fail. Check the Breeze release notes for the new version. If the change is expected, select **Accept changes from Breeze RMM**, or wait for a Weavestream release that knows the version. For other failures, pause the schedule if they repeat, preserve the failed run and gap evidence, and upgrade whichever side owns the contract change. Never edit an opaque cursor or force the old checkpoint forward. After the contract is compatible, run a full dry run followed by a real full traversal. Malformed JSON, a repeated cursor, or cross-company data fails before the affected page writes.

### Rate limiting, timeout, or provider outage

Honor `Retry-After`, reduce schedule/concurrency pressure if needed, and wait for the next retry or manual run. Do not create parallel traversals. The last committed cursor and local dossier remain valid. Once service returns, use incremental unless a full checkpoint is missing/expired or an operator needs disappearance reconciliation.

### Missing dependency or blocked definition

A resource is never skipped because of its dependencies. When a parent resource failed, is disabled, or has nothing to sync, each record whose link target is not synced becomes a safe `missing_dependency` gap instead of a dangling or cross-company relation. Device relationships depends only on sites, devices, virtual machines, and network equipment. To clear such gaps, enable the endpoint resource, map both relation endpoints to the same company, and grant the service principal the exact read scope. A secret-blocked item must be rewritten at its source to contain only durable non-secret reconstruction facts, then rerun; Weavestream does not offer a bypass that stores the rejected value.

**Values withheld in place.** Weavestream withholds a value, not a record. When a value in a synced record looks like a credential, Weavestream replaces it with `[withheld]` and syncs the rest of the record. In script content and other long text, only the matched part is replaced, so the script stays readable. The run shows **warnings**, and the conflict list has one "values withheld" line per record with the count and the field paths (for example `features[1].settings.destination.secretAccessKey`), never the value. A key that is not a plain identifier (for example one that contains `=` or spaces) shows as `[redacted]`, and a long path keeps its end. These values are withheld:

- The value of a field whose name is a credential name (for example `password`, `secret`, `token`, `apiKey`, `secretAccessKey`, `privateKey`, `psk`). An empty value (blank text, `null`, a boolean, a masked value such as `********`, an object with no keys, or a list of only those) is not withheld, so an empty S3 destination form shows as empty.
- The value of a custom field whose name is a credential name, for example "Local admin password".
- A credential assignment in text, for example `$Password = '…'`, `API_KEY=…`, `--password …`, or `ConvertTo-SecureString '…' -AsPlainText`.
- A value with a known credential shape: a private key block, a bearer or basic authorization value, user information in a URL, a GitHub, Slack, OpenAI-style, AWS, or Google API key, a JSON Web Token, or a long random string.

Breeze withholds credential fields before they leave Breeze. "Breeze withheld a … record" means the Breeze partner API held back the record; its gap details carry the field paths Breeze reported. Weavestream's own check is a second defense and does not replace that. A long hyphenated value that contains digits can look random and be withheld; name such a field for what it holds, or shorten the value.
