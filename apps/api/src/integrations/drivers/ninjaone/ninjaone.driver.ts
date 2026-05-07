import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
  DriverDescriptor,
  SourceFieldDto,
  SourceOrgDto,
} from '@weavestream/shared';
import {
  DriverAuthError,
  type DriverFetchPage,
  type DriverRecord,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
} from '../integration-driver.js';
import {
  fetchWithRetry,
  humanizeKey,
  inferHintType,
  sortByLabel,
} from '../driver-utils.js';

/**
 * Phase 11 — NinjaOne RMM driver.
 *
 * NinjaOne is a multi-step API:
 *   1. Exchange the Client ID + Client Secret for an OAuth2 access
 *      token via `POST /ws/oauth/token` (form-encoded
 *      `client_credentials` grant with `scope=monitoring`).
 *   2. List organisations the token can see via
 *      `GET /v2/organizations` — paginated by `pageSize` + `after=<id>`
 *      (last id seen).
 *   3. List devices per org via
 *      `GET /v2/devices-detailed?df=org={org_id}` — paginated the
 *      same way. The `-detailed` endpoint returns the `references`
 *      block (organization, location, role, policy, rolePolicy,
 *      warranty, assignedOwner, …) so we can project warranty dates,
 *      owner contact info, role / policy names, etc. onto the asset
 *      layout without a second round-trip per device.
 *      NB: the `?of=` shortcut works on the lean `/v2/devices` but
 *      is silently ignored on `/v2/devices-detailed`, so we use the
 *      universal `df` filter (`org=<id>`) instead.
 *
 * Secrets stored on the Integration row (UI shows "Client ID" /
 * "Client Secret" — on-disk keys mirror the Action1 driver so the
 * encrypted-blob shape is uniform across pull drivers):
 *   - `apiKey`     — NinjaOne OAuth2 Client ID
 *   - `apiSecret`  — NinjaOne OAuth2 Client Secret
 *
 * Config stored on the Integration row:
 *   - `baseUrl`    — defaults to `https://app.ninjarmm.com` (US region).
 *                    Override for EU (`eu.ninjarmm.com`),
 *                    CA (`ca.ninjarmm.com`) or OC (`oc.ninjarmm.com`).
 *
 * Per-mapping config (on `IntegrationCompanyMapping`):
 *   - `externalOrgId` — NinjaOne organisation id (column on the row,
 *                       stored as a string even though NinjaOne emits
 *                       it as an integer)
 *   - `filter`       — `{ locationIds?: number[] }` optional driver
 *                       filter. Applied post-fetch against
 *                       `device.locationId`.
 */
const NINJAONE_DEFAULT_BASE_URL = 'https://app.ninjarmm.com';
const NINJAONE_OAUTH_PATH = '/ws/oauth/token';
const NINJAONE_OAUTH_SCOPE = 'monitoring';

const ninjaoneConfigSchema = z.object({
  baseUrl: z.string().url().default(NINJAONE_DEFAULT_BASE_URL),
});

const ninjaoneSecretSchema = z.object({
  apiKey: z.string().min(1, 'Client ID is required'),
  apiSecret: z.string().min(1, 'Client Secret is required'),
});

const ninjaoneFilterSchema = z.object({
  locationIds: z.array(z.number().int()).optional(),
});

interface NinjaOneOrg {
  id: number;
  name: string;
  description?: string | null;
  [key: string]: unknown;
}

interface NinjaOneReferences {
  organization?: { name?: string; description?: string | null } | null;
  location?: {
    name?: string;
    address?: string | null;
    description?: string | null;
  } | null;
  role?: {
    name?: string;
    nodeClass?: string;
    chassisType?: string;
    custom?: boolean;
    icon?: string | null;
  } | null;
  policy?: {
    name?: string;
    nodeClass?: string;
    parentPolicyId?: number | null;
  } | null;
  rolePolicy?: {
    name?: string;
    nodeClass?: string;
    parentPolicyId?: number | null;
  } | null;
  warranty?: {
    startDate?: number | null;
    endDate?: number | null;
    manufacturerFulfillmentDate?: number | null;
  } | null;
  assignedOwner?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string | null;
    enabled?: boolean;
    userType?: string;
    invitationStatus?: string;
  } | null;
  [key: string]: unknown;
}

interface NinjaOneMaintenance {
  status?: string;
  start?: number | null;
  end?: number | null;
  reasonMessage?: string | null;
}

/**
 * Top-level shape of a NinjaOne device record from
 * `/v2/devices-detailed`. The set varies by `nodeClass` and tenant
 * config, so anything not declared here flows through the
 * `[key: string]: unknown` index and is still mappable from the
 * field-mapping UI via the live probe.
 */
interface NinjaOneDevice {
  id: number;
  uid?: string;
  assignedOwnerUid?: string | null;
  systemName?: string;
  dnsName?: string;
  netbiosName?: string;
  displayName?: string;
  nodeClass?: string;
  nodeRoleId?: number;
  rolePolicyId?: number | null;
  policyId?: number | null;
  organizationId?: number;
  locationId?: number;
  parentDeviceId?: number | null;
  /** Unix epoch seconds (with fractional ms). */
  lastContact?: number;
  /** Unix epoch seconds (with fractional ms). */
  lastUpdate?: number;
  /** Unix epoch seconds (with fractional ms). */
  created?: number;
  offline?: boolean;
  approvalStatus?: string;
  tags?: string[];
  maintenance?: NinjaOneMaintenance | null;
  references?: NinjaOneReferences | null;
  [key: string]: unknown;
}

export class NinjaOneDriver implements IntegrationDriver {
  private readonly logger = new Logger(NinjaOneDriver.name);
  readonly key = 'ninjaone';

  readonly descriptor: DriverDescriptor = {
    key: 'ninjaone',
    label: 'NinjaOne RMM',
    description:
      'Sync managed devices from NinjaOne organisations into Weavestream asset layouts.',
    iconKey: 'ninjaone',
    configFields: [
      {
        key: 'baseUrl',
        label: 'API Base URL',
        kind: 'url',
        required: false,
        description:
          'Defaults to the US region. Override for EU (eu.ninjarmm.com), CA (ca.ninjarmm.com) or OC (oc.ninjarmm.com).',
        default: NINJAONE_DEFAULT_BASE_URL,
      },
    ],
    secretFields: [
      {
        key: 'apiKey',
        label: 'Client ID',
        kind: 'text',
        required: true,
        description:
          'NinjaOne OAuth2 Client ID. Generate it under Administration → Apps → API.',
      },
      {
        key: 'apiSecret',
        label: 'Client Secret',
        kind: 'password',
        required: true,
        description:
          'NinjaOne OAuth2 Client Secret. Stored AES-256-GCM encrypted; never returned to the UI.',
      },
    ],
    resources: [
      {
        key: 'records',
        label: 'Devices',
        description:
          'NinjaOne managed devices (workstations / servers / network gear) per organisation.',
        defaultMatchKeyHint: 'systemName',
      },
    ],
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
    },
  };

  async testConnection(
    ctx: IntegrationContext,
  ): Promise<{ ok: true; details?: string }> {
    const orgs = await this.fetchAllOrgs(ctx);
    return {
      ok: true,
      details: `Reached NinjaOne (${orgs.length} organisations).`,
    };
  }

  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const orgs = await this.fetchAllOrgs(ctx);
    return orgs.map((o) => ({
      externalId: String(o.id),
      name: o.name,
      hint: o.description ?? null,
    }));
  }

  /**
   * Walks every page of `/v2/organizations` and returns the flattened
   * list. NinjaOne paginates collections via `pageSize` + `after=<id>`
   * (last id seen). We keep paging while we receive a full page; a
   * short page signals the tail.
   */
  private async fetchAllOrgs(ctx: IntegrationContext): Promise<NinjaOneOrg[]> {
    const { baseUrl } = parseConfig(ctx.config);
    const token = await this.getAccessToken(ctx);

    const pageSize = 200;
    const out: NinjaOneOrg[] = [];
    let after = 0;
    while (true) {
      const url = new URL(`${baseUrl}/v2/organizations`);
      url.searchParams.set('pageSize', String(pageSize));
      if (after > 0) url.searchParams.set('after', String(after));
      const items = await this.callJson<NinjaOneOrg[]>(url.toString(), {
        token,
        ctx,
      });
      const page = Array.isArray(items) ? items : [];
      out.push(...page);
      if (page.length < pageSize) break;
      const last = page[page.length - 1];
      if (!last || typeof last.id !== 'number') break;
      after = last.id;
      // Hard stop guard so a misbehaving tenant can never pin the API.
      if (out.length > 10_000) break;
    }
    return out;
  }

  /**
   * Probes NinjaOne for the *real* device schema so the field-mapping
   * UI exposes everything the tenant's agent reports — vendor, model,
   * serial, last contact, OS build, role / policy names, warranty
   * dates, owner contact info, etc. — not just the curated subset
   * hard-coded below.
   *
   * Implementation:
   *  1. Pull a small sample (5 records) from
   *     `/v2/devices-detailed?df=org={org_id}&pageSize=5`.
   *  2. Run each sample through the same `normalizeNinjaOneRecordFields`
   *     pass that `fetchRecords` uses, so the probe sees the flattened
   *     reference keys (warrantyEndDate, assignedOwnerEmail, roleName,
   *     locationName, …) the UI will eventually project.
   *  3. Union all top-level keys across the normalised sample. Skip
   *     nested objects, but allow string-arrays through as `TAGS`.
   *  4. For each key, prefer the curated label / hint-type if present;
   *     otherwise infer the type from the sample values and humanise
   *     the camelCase key into a label.
   *  5. If the probe fails (no creds, empty org, network blip), fall
   *     back to the curated catalogue so the UI is never empty.
   */
  async listSourceFields(
    ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
  ): Promise<SourceFieldDto[]> {
    if (!ctx.externalOrgId) {
      return sortByLabel([...NINJAONE_KNOWN_FIELDS]);
    }

    let samples: NinjaOneDevice[] = [];
    try {
      samples = await this.fetchDeviceSamples(ctx, 5);
    } catch (err) {
      this.logger.warn(
        `NinjaOne listSourceFields probe failed for org ${ctx.externalOrgId}: ${
          (err as Error).message
        } — returning curated catalogue.`,
      );
      return sortByLabel([...NINJAONE_KNOWN_FIELDS]);
    }

    if (samples.length === 0) {
      return sortByLabel([...NINJAONE_KNOWN_FIELDS]);
    }

    const normalized = samples.map(normalizeNinjaOneRecordFields);
    const known = new Map(NINJAONE_KNOWN_FIELDS.map((f) => [f.key, f]));
    const seenKeys = new Set<string>();
    for (const r of normalized) {
      for (const k of Object.keys(r ?? {})) seenKeys.add(k);
    }
    // Always include curated keys even if absent in the sample — they
    // may legitimately be null on these specific devices but real on
    // others in the org.
    for (const k of known.keys()) seenKeys.add(k);

    const out: SourceFieldDto[] = [];
    for (const key of seenKeys) {
      // `id` is the externalId — handled separately by the sync
      // record, never user-mappable.
      if (key === 'id') continue;

      const sampleValues: unknown[] = [];
      let nonNullCount = 0;
      for (const r of normalized) {
        const v = (r as Record<string, unknown>)[key];
        if (v === null || v === undefined || v === '') continue;
        sampleValues.push(v);
        nonNullCount += 1;
      }

      // Skip nested objects & arrays-of-objects — operators can't
      // usefully map them onto primitive AssetFields. String arrays
      // (e.g. `tags`) ARE allowed through and surfaced as `TAGS`.
      if (
        sampleValues.some(
          (v) =>
            typeof v === 'object' &&
            v !== null &&
            !(v instanceof Date) &&
            !isStringArray(v),
        )
      ) {
        continue;
      }

      const curated = known.get(key);
      const alwaysPresent =
        normalized.length > 0 && nonNullCount === normalized.length;

      if (curated) {
        out.push({
          ...curated,
          alwaysPresent: curated.alwaysPresent || alwaysPresent,
        });
      } else {
        const allStringArrays =
          sampleValues.length > 0 && sampleValues.every(isStringArray);
        out.push({
          key,
          label: humanizeKey(key),
          hintType: allStringArrays ? 'TAGS' : inferHintType(sampleValues),
          alwaysPresent,
        });
      }
    }

    return sortByLabel(out);
  }

  private async fetchDeviceSamples(
    ctx: IntegrationContext & { externalOrgId: string },
    pageSize: number,
  ): Promise<NinjaOneDevice[]> {
    const { baseUrl } = parseConfig(ctx.config);
    const token = await this.getAccessToken(ctx);
    const url = new URL(`${baseUrl}/v2/devices-detailed`);
    // Scope by organisation via NinjaOne's "Device Filter" query param.
    // The `?of=` shortcut is documented for `/v2/devices` (lean) but
    // is silently ignored on `/v2/devices-detailed`, which would
    // otherwise return every device the API client can see — that
    // bug leaked all-orgs into the first tenant on initial sync.
    url.searchParams.set('df', `org=${ctx.externalOrgId}`);
    url.searchParams.set('pageSize', String(pageSize));
    const items = await this.callJson<NinjaOneDevice[]>(url.toString(), {
      token,
      ctx,
    });
    return Array.isArray(items) ? items : [];
  }

  async fetchRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<DriverFetchPage> {
    const { baseUrl } = parseConfig(ctx.config);
    const token = await this.getAccessToken(ctx);
    const filter = ninjaoneFilterSchema.parse(ctx.filter ?? {});

    const pageSize = 200;
    let after = 0;
    if (cursor !== null) {
      const parsed = Number.parseInt(cursor, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid NinjaOne fetch cursor: ${cursor}`);
      }
      after = parsed;
    }

    const url = new URL(`${baseUrl}/v2/devices-detailed`);
    // Scope by organisation via NinjaOne's "Device Filter" query param
    // (`?df=org=<id>`). NinjaOne's `?of=` shortcut works on the lean
    // `/v2/devices` endpoint but is silently ignored on
    // `/v2/devices-detailed` — using it caused every visible device,
    // across every org the API client could see, to land in the
    // single mapped Weavestream company on first sync.
    url.searchParams.set('df', `org=${ctx.externalOrgId}`);
    url.searchParams.set('pageSize', String(pageSize));
    if (after > 0) url.searchParams.set('after', String(after));

    const items = await this.callJson<NinjaOneDevice[]>(url.toString(), {
      token,
      ctx,
    });
    const raw = Array.isArray(items) ? items : [];

    // Defensive backstop: if the upstream `df` filter is ever silently
    // ignored again (NinjaOne API quirk, deprecated parameter, etc.)
    // we MUST NOT fan devices from other orgs into this tenant. Drop
    // any record whose `organizationId` doesn't match the mapping's
    // configured org and log a warning so the regression is loud.
    const expectedOrgId = Number.parseInt(ctx.externalOrgId, 10);
    const orgScoped = Number.isFinite(expectedOrgId)
      ? raw.filter((d) => {
          if (typeof d.organizationId !== 'number') return true;
          if (d.organizationId === expectedOrgId) return true;
          this.logger.warn(
            `NinjaOne returned device id=${d.id} from org ${d.organizationId} for a request scoped to org ${expectedOrgId}; dropping. The upstream df=org filter may have been ignored.`,
          );
          return false;
        })
      : raw;

    const filtered = filter.locationIds?.length
      ? orgScoped.filter(
          (d) =>
            typeof d.locationId === 'number' &&
            filter.locationIds!.includes(d.locationId),
        )
      : orgScoped;

    const records: DriverRecord[] = filtered.map((d) => {
      const fields = normalizeNinjaOneRecordFields(d);
      return {
        externalId: String(d.id),
        // NinjaOne's authoritative display label is `systemName`; fall
        // back to `dnsName` and finally `displayName` so unmanaged or
        // partially-onboarded devices still render with something
        // meaningful in the asset list.
        displayName:
          (d.systemName && String(d.systemName)) ||
          (d.dnsName && String(d.dnsName)) ||
          (d.displayName && String(d.displayName)) ||
          null,
        fields,
        updatedAt:
          typeof fields.lastContact === 'string' ? fields.lastContact : null,
      };
    });

    // The full unfiltered page count drives both pagination decisions
    // and cursor advancement — the post-fetch location filter must not
    // shorten the cursor walk and skip later devices.
    const hasMore = raw.length >= pageSize;
    const lastRaw = raw[raw.length - 1];
    const nextCursor =
      hasMore && lastRaw && typeof lastRaw.id === 'number'
        ? String(lastRaw.id)
        : null;

    return {
      records,
      hasMore: nextCursor !== null,
      cursor: nextCursor,
    };
  }

  // -------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------

  private async getAccessToken(ctx: IntegrationContext): Promise<string> {
    const { baseUrl } = parseConfig(ctx.config);
    const { apiKey, apiSecret } = ninjaoneSecretSchema.parse(ctx.secret);

    const tokenUrl = `${baseUrl.replace(/\/$/, '')}${NINJAONE_OAUTH_PATH}`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: apiSecret,
      scope: NINJAONE_OAUTH_SCOPE,
    });

    const res = await fetchWithRetry(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: 'NinjaOne',
    });

    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        `NinjaOne token exchange failed (${res.status}). Check the Client ID, Client Secret, and that the API client has the "monitoring" scope.`,
      );
    }
    if (!res.ok) {
      throw new Error(`NinjaOne token exchange returned HTTP ${res.status}`);
    }

    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new DriverAuthError(
        'NinjaOne token exchange did not return access_token.',
      );
    }
    return json.access_token;
  }

  private async callJson<T>(
    url: string,
    opts: { token: string; ctx: IntegrationContext },
  ): Promise<T> {
    const res = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
      },
      timeoutMs: opts.ctx.http.timeoutMs,
      maxRetries: opts.ctx.http.maxRetries,
      backoffMs: opts.ctx.http.backoffMs,
      correlationId: opts.ctx.correlationId,
      serviceName: 'NinjaOne',
    });

    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        `NinjaOne GET ${url} returned ${res.status}. Token rejected.`,
      );
    }
    if (!res.ok) {
      throw new Error(`NinjaOne GET ${url} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

function parseConfig(raw: Record<string, unknown>): { baseUrl: string } {
  return ninjaoneConfigSchema.parse(raw ?? {});
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * NinjaOne emits its datetime fields as fractional Unix epoch seconds
 * (e.g. `1714000000.123`). Normalise to an ISO 8601 string for every
 * known datetime key — both top-level (`lastContact`, `lastUpdate`,
 * `created`) and the warranty / maintenance subtree fields after they
 * are flattened — so the framework's `updatedAt` conflict resolver
 * and the field-mapping projection see a consistent shape.
 */
const NINJAONE_EPOCH_SECONDS_KEYS = new Set([
  'lastContact',
  'lastUpdate',
  'lastLoggedInUserUpdate',
  'created',
  'osLastBootTime',
  'warrantyStartDate',
  'warrantyEndDate',
  'warrantyManufacturerFulfillmentDate',
  'maintenanceStart',
  'maintenanceEnd',
]);

/**
 * Subtrees on the raw NinjaOne device record that we promote into
 * top-level camelCase keys instead of passing through verbatim. These
 * are dropped from the output after flattening so the field-mapping UI
 * never sees un-mappable nested objects or arrays-of-objects.
 */
const NINJAONE_HANDLED_SUBTREES = new Set([
  'references',
  'maintenance',
  'userData',
  'os',
  'system',
  'memory',
  'processors',
  'volumes',
]);

/**
 * Flattens a raw NinjaOne device record onto a single-level object
 * keyed by the source-field names the field-mapping UI / curated
 * catalogue expects. The strategy:
 *
 *   - Pass through every scalar top-level key untouched.
 *   - Normalise known epoch-seconds fields to ISO datetime strings.
 *   - Promote the `os`, `system`, `memory` blocks into camelCase keys
 *     (`os.name` → `osName`, `system.manufacturer` → `systemManufacturer`,
 *     `memory.capacity` → `memoryCapacity`, …) so the hardware /
 *     operating-system data the agent reports is actually mappable.
 *   - Promote the first `processors[]` and `volumes[]` entry plus a
 *     `volumeCount` aggregate so multi-disk / multi-CPU hosts at least
 *     surface their primary CPU + first volume. Operators needing the
 *     full multi-volume / multi-CPU detail can reach for the per-device
 *     NinjaOne endpoints separately.
 *   - Promote the useful `references.*` subtrees the same way
 *     (`references.warranty.endDate` → `warrantyEndDate`,
 *     `references.assignedOwner.email` → `assignedOwnerEmail`, …).
 *   - Promote the `maintenance.*` block.
 *   - Drop the raw `references`, `maintenance`, `userData`, `os`,
 *     `system`, `memory`, `processors`, `volumes` blocks so they
 *     don't pollute the field-mapping UI as un-mappable nested
 *     objects.
 *   - Leave `tags` / `ipAddresses` / `macAddresses` (string arrays)
 *     intact so the probe can surface them as `TAGS`.
 */
function normalizeNinjaOneRecordFields(
  record: NinjaOneDevice,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (NINJAONE_HANDLED_SUBTREES.has(key)) {
      // Handled below (or intentionally dropped).
      continue;
    }
    if (NINJAONE_EPOCH_SECONDS_KEYS.has(key) && typeof value === 'number') {
      out[key] = epochSecondsToIso(value) ?? value;
    } else {
      out[key] = value;
    }
  }

  // ----- Hardware / OS subtrees (the user-reported missing data) -----

  const os = (record as Record<string, unknown>).os;
  flattenInto(out, 'os', os, [
    ['name', 'osName'],
    ['locale', 'osLocale'],
    ['language', 'osLanguage'],
    ['releaseId', 'osReleaseId'],
    ['buildNumber', 'osBuildNumber'],
    ['needsReboot', 'osNeedsReboot'],
    ['architecture', 'osArchitecture'],
    ['lastBootTime', 'osLastBootTime'],
    ['manufacturer', 'osManufacturer'],
    ['servicePackMajorVersion', 'osServicePackMajorVersion'],
    ['servicePackMinorVersion', 'osServicePackMinorVersion'],
  ]);

  const system = (record as Record<string, unknown>).system;
  // NB: skip `system.name` — it duplicates the top-level `systemName`
  // and clobbering would lose the agent-reported variant.
  flattenInto(out, 'system', system, [
    ['model', 'systemModel'],
    ['domain', 'systemDomain'],
    ['domainRole', 'systemDomainRole'],
    ['chassisType', 'systemChassisType'],
    ['manufacturer', 'systemManufacturer'],
    ['serialNumber', 'systemSerialNumber'],
    ['virtualMachine', 'systemVirtualMachine'],
    ['biosSerialNumber', 'systemBiosSerialNumber'],
    ['assetSerialNumber', 'systemAssetSerialNumber'],
    ['numberOfProcessors', 'systemNumberOfProcessors'],
    ['totalPhysicalMemory', 'systemTotalPhysicalMemory'],
  ]);

  const memory = (record as Record<string, unknown>).memory;
  flattenInto(out, 'memory', memory, [['capacity', 'memoryCapacity']]);

  const processors = (record as Record<string, unknown>).processors;
  if (Array.isArray(processors) && processors.length > 0) {
    flattenInto(out, 'processor', processors[0], [
      ['name', 'processorName'],
      ['numCores', 'processorNumCores'],
      ['clockSpeed', 'processorClockSpeed'],
      ['architecture', 'processorArchitecture'],
      ['maxClockSpeed', 'processorMaxClockSpeed'],
      ['numLogicalCores', 'processorNumLogicalCores'],
    ]);
  }

  const volumes = (record as Record<string, unknown>).volumes;
  if (Array.isArray(volumes)) {
    out.volumeCount = volumes.length;
    if (volumes.length > 0) {
      flattenInto(out, 'firstVolume', volumes[0], [
        ['name', 'firstVolumeName'],
        ['label', 'firstVolumeLabel'],
        ['fileSystem', 'firstVolumeFileSystem'],
        ['deviceType', 'firstVolumeDeviceType'],
        ['serialNumber', 'firstVolumeSerialNumber'],
        ['capacity', 'firstVolumeCapacity'],
        ['freeSpace', 'firstVolumeFreeSpace'],
      ]);
    }
  }

  // ----- references.* + maintenance subtrees -----

  const refs = record.references ?? null;
  if (refs && typeof refs === 'object') {
    flattenInto(out, 'organization', refs.organization, [
      ['name', 'organizationName'],
      ['description', 'organizationDescription'],
    ]);
    flattenInto(out, 'location', refs.location, [
      ['name', 'locationName'],
      ['address', 'locationAddress'],
      ['description', 'locationDescription'],
    ]);
    flattenInto(out, 'role', refs.role, [
      ['name', 'roleName'],
      ['nodeClass', 'roleNodeClass'],
      ['chassisType', 'roleChassisType'],
      ['custom', 'roleCustom'],
      ['icon', 'roleIcon'],
    ]);
    flattenInto(out, 'policy', refs.policy, [
      ['name', 'policyName'],
      ['nodeClass', 'policyNodeClass'],
      ['parentPolicyId', 'policyParentPolicyId'],
    ]);
    flattenInto(out, 'rolePolicy', refs.rolePolicy, [
      ['name', 'rolePolicyName'],
      ['nodeClass', 'rolePolicyNodeClass'],
      ['parentPolicyId', 'rolePolicyParentPolicyId'],
    ]);
    flattenInto(out, 'warranty', refs.warranty, [
      ['startDate', 'warrantyStartDate'],
      ['endDate', 'warrantyEndDate'],
      ['manufacturerFulfillmentDate', 'warrantyManufacturerFulfillmentDate'],
    ]);
    flattenInto(out, 'assignedOwner', refs.assignedOwner, [
      ['firstName', 'assignedOwnerFirstName'],
      ['lastName', 'assignedOwnerLastName'],
      ['email', 'assignedOwnerEmail'],
      ['phone', 'assignedOwnerPhone'],
      ['enabled', 'assignedOwnerEnabled'],
      ['userType', 'assignedOwnerUserType'],
      ['invitationStatus', 'assignedOwnerInvitationStatus'],
    ]);
  }

  const maint = record.maintenance ?? null;
  if (maint && typeof maint === 'object') {
    flattenInto(out, 'maintenance', maint, [
      ['status', 'maintenanceStatus'],
      ['start', 'maintenanceStart'],
      ['end', 'maintenanceEnd'],
      ['reasonMessage', 'maintenanceReason'],
    ]);
  }

  // Apply the epoch normaliser to flattened keys (osLastBootTime,
  // warranty + maintenance dates all land here as raw numbers from
  // the source object).
  for (const key of NINJAONE_EPOCH_SECONDS_KEYS) {
    const v = out[key];
    if (typeof v === 'number') out[key] = epochSecondsToIso(v) ?? v;
  }

  // Derive scalar variants of the IP / MAC arrays so operators can
  // map a single value onto TEXT / IP_ADDRESS / rich-text fields. The
  // raw `ipAddresses` / `macAddresses` arrays remain available for
  // mapping onto TAGS-typed AssetFields — but most asset layouts
  // model "IP address" as a single value, and arrays don't project
  // onto scalar field types.
  if (Array.isArray(out.ipAddresses) && isStringArray(out.ipAddresses)) {
    const primary = pickPrimaryIp(out.ipAddresses);
    if (primary !== null) out.primaryIpAddress = primary;
  }
  if (Array.isArray(out.macAddresses) && isStringArray(out.macAddresses)) {
    const primaryMac = out.macAddresses[0];
    if (primaryMac) out.primaryMacAddress = primaryMac;
  }

  return out;
}

/**
 * Picks the most useful single IP from NinjaOne's `ipAddresses` array.
 *
 * NinjaOne sometimes packs multiple addresses into one slot, joined by
 * `|` (typically the IPv6 GUA + link-local pair, e.g.
 * `"fde1:53ba:e9a0:de11:1c96:85c6:8728:105c|fe80::182c:1a99:8294:95d3"`).
 * We split those before scoring.
 *
 * Preference order:
 *   1. Non-link-local, non-loopback IPv4 (`10.x` / `192.168.x` / public).
 *   2. Non-link-local IPv6 (GUA, ULA — anything not `fe80::` / `::1`).
 *   3. First entry as a last resort, so we never silently drop the
 *      whole field on tenants whose primary is a flavour we didn't
 *      anticipate.
 */
function pickPrimaryIp(ips: string[]): string | null {
  const flat: string[] = [];
  for (const raw of ips) {
    for (const part of raw.split('|')) {
      const trimmed = part.trim();
      if (trimmed) flat.push(trimmed);
    }
  }
  if (flat.length === 0) return null;
  for (const s of flat) if (isUsableIpv4(s)) return s;
  for (const s of flat) if (isUsableIpv6(s)) return s;
  return flat[0] ?? null;
}

function isUsableIpv4(s: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return false;
  if (s.startsWith('169.254.')) return false; // link-local / APIPA
  if (s.startsWith('127.')) return false; // loopback
  if (s === '0.0.0.0') return false;
  return true;
}

function isUsableIpv6(s: string): boolean {
  if (!s.includes(':')) return false;
  const lower = s.toLowerCase();
  if (lower.startsWith('fe80')) return false; // link-local
  if (lower === '::1' || lower === '::') return false; // loopback / unspecified
  return true;
}

function flattenInto(
  out: Record<string, unknown>,
  _parentKey: string,
  source: unknown,
  mappings: ReadonlyArray<readonly [string, string]>,
): void {
  if (!source || typeof source !== 'object') return;
  const src = source as Record<string, unknown>;
  for (const [from, to] of mappings) {
    const v = src[from];
    if (v === undefined) continue;
    out[to] = v;
  }
}

function epochSecondsToIso(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds < 1e11 ? seconds * 1000 : seconds;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Curated field catalogue for NinjaOne managed devices.
 *
 * Two roles:
 *   1. Authoritative override for label + hintType when the live
 *      probe surfaces these keys (so e.g. `lastContact` is always
 *      labelled "Last contact" with `DATETIME`, not whatever the
 *      auto-humaniser would emit on a raw numeric epoch).
 *   2. Fallback list when the live probe can't run (no org, empty
 *      org, network blip).
 *
 * Includes the camelCase top-level keys we promote out of the
 * `os`, `system`, `memory`, `processors[0]`, `volumes[0]`,
 * `references.*`, and `maintenance.*` subtrees so OS / make / model /
 * serial / warranty / owner / role / policy / location data appear in
 * the field-mapping UI even on tenants whose first sample doesn't
 * happen to populate them.
 *
 * The live probe will surface tenant-specific top-level fields the
 * NinjaOne agent reports beyond this set; this catalogue is the
 * floor, not the ceiling.
 */
const NINJAONE_KNOWN_FIELDS: SourceFieldDto[] = [
  // Identity / classification
  { key: 'systemName', label: 'System name', hintType: 'TEXT', alwaysPresent: true },
  { key: 'dnsName', label: 'DNS name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'netbiosName', label: 'NetBIOS name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'displayName', label: 'Display name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'uid', label: 'Device UID', hintType: 'TEXT', alwaysPresent: true },
  { key: 'nodeClass', label: 'Node class', hintType: 'TEXT', alwaysPresent: true },
  { key: 'deviceType', label: 'Device type', hintType: 'TEXT', alwaysPresent: false },
  { key: 'nodeRoleId', label: 'Node role ID', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'rolePolicyId', label: 'Role policy ID', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'policyId', label: 'Policy ID', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'organizationId', label: 'Organization ID', hintType: 'NUMBER', alwaysPresent: true },
  { key: 'locationId', label: 'Location ID', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'parentDeviceId', label: 'Parent device ID', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'approvalStatus', label: 'Approval status', hintType: 'TEXT', alwaysPresent: false },
  { key: 'offline', label: 'Offline', hintType: 'BOOLEAN', alwaysPresent: false },
  { key: 'tags', label: 'Tags', hintType: 'TAGS', alwaysPresent: false },
  { key: 'lastLoggedInUser', label: 'Last logged-in user', hintType: 'TEXT', alwaysPresent: false },

  // Network (top-level scalars + string arrays + derived primaries)
  { key: 'publicIP', label: 'Public IP', hintType: 'IP_ADDRESS', alwaysPresent: false },
  // Derived single-value variants — map these onto IP_ADDRESS / TEXT /
  // rich-text fields. The raw arrays below are available for TAGS-
  // typed fields but won't project onto scalar field types.
  { key: 'primaryIpAddress', label: 'Primary IP address', hintType: 'IP_ADDRESS', alwaysPresent: false },
  { key: 'primaryMacAddress', label: 'Primary MAC address', hintType: 'TEXT', alwaysPresent: false },
  { key: 'ipAddresses', label: 'IP addresses (all)', hintType: 'TAGS', alwaysPresent: false },
  { key: 'macAddresses', label: 'MAC addresses (all)', hintType: 'TAGS', alwaysPresent: false },

  // Operating system (flattened from `os`)
  { key: 'osName', label: 'OS name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'osManufacturer', label: 'OS manufacturer', hintType: 'TEXT', alwaysPresent: false },
  { key: 'osArchitecture', label: 'OS architecture', hintType: 'TEXT', alwaysPresent: false },
  { key: 'osBuildNumber', label: 'OS build number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'osReleaseId', label: 'OS release ID', hintType: 'TEXT', alwaysPresent: false },
  { key: 'osLanguage', label: 'OS language', hintType: 'TEXT', alwaysPresent: false },
  { key: 'osLocale', label: 'OS locale', hintType: 'TEXT', alwaysPresent: false },
  { key: 'osNeedsReboot', label: 'OS needs reboot', hintType: 'BOOLEAN', alwaysPresent: false },
  { key: 'osLastBootTime', label: 'OS last boot time', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'osServicePackMajorVersion', label: 'OS service pack major', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'osServicePackMinorVersion', label: 'OS service pack minor', hintType: 'NUMBER', alwaysPresent: false },

  // Computer system / hardware (flattened from `system`)
  { key: 'systemManufacturer', label: 'Make', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemModel', label: 'Model', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemSerialNumber', label: 'Serial number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemBiosSerialNumber', label: 'BIOS serial number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemAssetSerialNumber', label: 'Asset serial number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemDomain', label: 'Domain', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemDomainRole', label: 'Domain role', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemChassisType', label: 'Chassis type', hintType: 'TEXT', alwaysPresent: false },
  { key: 'systemVirtualMachine', label: 'Is virtual machine', hintType: 'BOOLEAN', alwaysPresent: false },
  { key: 'systemNumberOfProcessors', label: 'Processor count', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'systemTotalPhysicalMemory', label: 'Total physical memory (bytes)', hintType: 'NUMBER', alwaysPresent: false },

  // Memory (flattened from `memory`)
  { key: 'memoryCapacity', label: 'Memory capacity (bytes)', hintType: 'NUMBER', alwaysPresent: false },

  // First processor (flattened from `processors[0]`)
  { key: 'processorName', label: 'Processor', hintType: 'TEXT', alwaysPresent: false },
  { key: 'processorArchitecture', label: 'Processor architecture', hintType: 'TEXT', alwaysPresent: false },
  { key: 'processorNumCores', label: 'Processor cores', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'processorNumLogicalCores', label: 'Processor logical cores', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'processorClockSpeed', label: 'Processor clock speed (Hz)', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'processorMaxClockSpeed', label: 'Processor max clock speed (Hz)', hintType: 'NUMBER', alwaysPresent: false },

  // Volumes — full per-volume detail isn't projectable onto primitive
  // AssetFields, so surface the count + the first volume's headline
  // attributes. Operators wanting per-volume reporting can hit the
  // NinjaOne /v2/queries/volumes endpoint directly.
  { key: 'volumeCount', label: 'Volume count', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'firstVolumeName', label: 'First volume name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeLabel', label: 'First volume label', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeFileSystem', label: 'First volume filesystem', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeDeviceType', label: 'First volume device type', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeSerialNumber', label: 'First volume serial number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeCapacity', label: 'First volume capacity (bytes)', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'firstVolumeFreeSpace', label: 'First volume free space (bytes)', hintType: 'NUMBER', alwaysPresent: false },

  // Lifecycle timestamps
  { key: 'lastContact', label: 'Last contact', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'lastUpdate', label: 'Last update', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'created', label: 'Created', hintType: 'DATETIME', alwaysPresent: false },

  // Organization (flattened from references.organization)
  { key: 'organizationName', label: 'Organization', hintType: 'TEXT', alwaysPresent: false },
  { key: 'organizationDescription', label: 'Organization description', hintType: 'TEXT', alwaysPresent: false },

  // Location (flattened from references.location)
  { key: 'locationName', label: 'Location', hintType: 'TEXT', alwaysPresent: false },
  { key: 'locationAddress', label: 'Location address', hintType: 'TEXT', alwaysPresent: false },
  { key: 'locationDescription', label: 'Location description', hintType: 'TEXT', alwaysPresent: false },

  // Role (flattened from references.role)
  { key: 'roleName', label: 'Role', hintType: 'TEXT', alwaysPresent: false },
  { key: 'roleNodeClass', label: 'Role node class', hintType: 'TEXT', alwaysPresent: false },
  { key: 'roleChassisType', label: 'Chassis type', hintType: 'TEXT', alwaysPresent: false },
  { key: 'roleCustom', label: 'Role is custom', hintType: 'BOOLEAN', alwaysPresent: false },
  { key: 'roleIcon', label: 'Role icon', hintType: 'TEXT', alwaysPresent: false },

  // Policy (flattened from references.policy)
  { key: 'policyName', label: 'Policy', hintType: 'TEXT', alwaysPresent: false },
  { key: 'policyNodeClass', label: 'Policy node class', hintType: 'TEXT', alwaysPresent: false },
  { key: 'policyParentPolicyId', label: 'Parent policy ID', hintType: 'NUMBER', alwaysPresent: false },

  // Role policy (flattened from references.rolePolicy — the role-default policy)
  { key: 'rolePolicyName', label: 'Role policy', hintType: 'TEXT', alwaysPresent: false },
  { key: 'rolePolicyNodeClass', label: 'Role policy node class', hintType: 'TEXT', alwaysPresent: false },
  { key: 'rolePolicyParentPolicyId', label: 'Role policy parent ID', hintType: 'NUMBER', alwaysPresent: false },

  // Warranty (flattened from references.warranty)
  { key: 'warrantyStartDate', label: 'Warranty start', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'warrantyEndDate', label: 'Warranty end', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'warrantyManufacturerFulfillmentDate', label: 'Warranty manufacturer fulfilment', hintType: 'DATETIME', alwaysPresent: false },

  // Assigned owner (flattened from references.assignedOwner)
  { key: 'assignedOwnerUid', label: 'Assigned owner UID', hintType: 'TEXT', alwaysPresent: false },
  { key: 'assignedOwnerFirstName', label: 'Assigned owner first name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'assignedOwnerLastName', label: 'Assigned owner last name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'assignedOwnerEmail', label: 'Assigned owner email', hintType: 'EMAIL', alwaysPresent: false },
  { key: 'assignedOwnerPhone', label: 'Assigned owner phone', hintType: 'TEXT', alwaysPresent: false },
  { key: 'assignedOwnerEnabled', label: 'Assigned owner enabled', hintType: 'BOOLEAN', alwaysPresent: false },
  { key: 'assignedOwnerUserType', label: 'Assigned owner user type', hintType: 'TEXT', alwaysPresent: false },
  { key: 'assignedOwnerInvitationStatus', label: 'Assigned owner invitation status', hintType: 'TEXT', alwaysPresent: false },

  // Maintenance window (flattened from maintenance)
  { key: 'maintenanceStatus', label: 'Maintenance status', hintType: 'TEXT', alwaysPresent: false },
  { key: 'maintenanceStart', label: 'Maintenance start', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'maintenanceEnd', label: 'Maintenance end', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'maintenanceReason', label: 'Maintenance reason', hintType: 'TEXT', alwaysPresent: false },
];
