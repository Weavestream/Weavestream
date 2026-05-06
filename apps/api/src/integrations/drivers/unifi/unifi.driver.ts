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
 * UniFi Site Manager driver — multi-resource (devices + clients).
 *
 * Two parallel sync streams share one set of credentials and one set
 * of `host ↔ company` mappings:
 *
 *   1. `devices` — Site Manager API. `GET /v1/devices` returns hosts
 *      (consoles) with their nested devices, paginated by `nextToken`.
 *      External id = `device.id` (with MAC fallback).
 *
 *   2. `clients` — Network Integration API exposed through Site Manager
 *      proxy:
 *        a. `GET /v1/connector/consoles/{consoleId}/proxy/network/integration/v1/sites`
 *           enumerates the sites managed by the console.
 *        b. `GET .../sites/{siteId}/clients?offset=N&limit=N` pages
 *           each site's clients.
 *      External id = `client.id` (UniFi UUID — stable across syncs).
 *      The list endpoint exposes a deliberately small field set
 *      (`type`, `name`, `connectedAt`, `ipAddress`, `access`); MAC
 *      lives on the per-client detail endpoint and is not fetched
 *      here (would N+1 every sync). Operators match on `name` /
 *      `ipAddress` / etc. — once claimed, the hidden
 *      `IntegrationSyncRecord(externalId)` binding survives drift.
 *
 * `consoleId == hostId`: UniFi's terminology is inconsistent ("host"
 * in the Site Manager surface, "console" in the connector proxy URL)
 * but both refer to the same controller. The driver reuses the
 * `IntegrationCompanyMapping.externalOrgId` (already a hostId) as the
 * `consoleId` for the proxy URL.
 *
 * Auth: API key in `X-API-Key`.
 *
 * Response envelope:
 *   - `/v1/devices` and `/v1/sites` (Site Manager):
 *       { data: [...], httpStatusCode, traceId, nextToken?: string|null }
 *   - `/proxy/.../sites` and `/proxy/.../sites/{siteId}/clients`:
 *       { offset, limit, count, totalCount, data: [...] }
 */

const UNIFI_DEFAULT_BASE_URL = 'https://api.ui.com';
const UNIFI_PAGE_SIZE = 200;
const UNIFI_CLIENT_PAGE_SIZE = 200;

const UNIFI_RESOURCE_DEVICES = 'devices' as const;
const UNIFI_RESOURCE_CLIENTS = 'clients' as const;

const unifiConfigSchema = z.object({
  baseUrl: z.string().url().default(UNIFI_DEFAULT_BASE_URL),
});

const unifiSecretSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
});

const unifiFilterSchema = z.object({
  productLines: z.array(z.string()).optional(),
  managedOnly: z.boolean().optional(),
});

interface UniFiPage<T> {
  data?: T[];
  nextToken?: string | null;
  next_token?: string | null;
}

interface UniFiOffsetPage<T> {
  data?: T[];
  offset?: number;
  limit?: number;
  count?: number;
  totalCount?: number;
}

interface UniFiHostGroup {
  hostId?: string;
  hostName?: string;
  updatedAt?: string;
  devices?: UniFiDevice[];
  [key: string]: unknown;
}

interface UniFiDevice {
  id?: string;
  mac?: string;
  name?: string;
  model?: string;
  shortname?: string;
  ip?: string;
  productLine?: string;
  status?: string;
  version?: string;
  firmwareStatus?: string;
  updateAvailable?: string;
  isConsole?: boolean;
  isManaged?: boolean;
  startupTime?: string;
  adoptionTime?: string;
  note?: string;
  uidb?: Record<string, unknown>;
  [key: string]: unknown;
}

interface UniFiSite {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

interface UniFiClient {
  id?: string;
  name?: string;
  type?: string;
  connectedAt?: string;
  ipAddress?: string;
  access?: { type?: string } | null;
  [key: string]: unknown;
}

/**
 * Opaque cursor encoding the multi-site walker state for the clients
 * resource. Round-tripped through base64 so the runner sees a single
 * string but the driver can resume across the (siteIdx, offset)
 * dimensions on every page call.
 */
interface UniFiClientCursor {
  siteIds: string[];
  siteNames: Record<string, string | null>;
  siteIdx: number;
  offset: number;
}

export class UniFiSiteManagerDriver implements IntegrationDriver {
  private readonly logger = new Logger(UniFiSiteManagerDriver.name);
  readonly key = 'unifi';

  readonly descriptor: DriverDescriptor = {
    key: 'unifi',
    label: 'UniFi Site Manager',
    description:
      'Sync UniFi Site Manager devices and Network clients into Weavestream asset layouts.',
    iconKey: null,
    configFields: [
      {
        key: 'baseUrl',
        label: 'API Base URL',
        kind: 'url',
        required: false,
        description: 'Override only if UniFi provides a custom API host.',
        default: UNIFI_DEFAULT_BASE_URL,
      },
    ],
    secretFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        kind: 'password',
        required: true,
        description:
          'UniFi Site Manager API key. Stored AES-256-GCM encrypted; never returned to the UI.',
      },
    ],
    resources: [
      {
        key: UNIFI_RESOURCE_DEVICES,
        label: 'Devices',
        description:
          'UniFi-managed network devices (switches, access points, gateways) reported by the Site Manager API.',
        defaultMatchKeyHint: 'mac',
      },
      {
        key: UNIFI_RESOURCE_CLIENTS,
        label: 'Clients',
        description:
          'Connected client devices reported by the UniFi Network Integration API for every site under each mapped console.',
        defaultMatchKeyHint: 'name',
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
    const { baseUrl } = parseConfig(ctx.config);
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/v1/devices`);
    url.searchParams.set('pageSize', '1');
    const body = await this.callJson<UniFiPage<UniFiHostGroup>>(
      url.toString(),
      ctx,
    );
    const visible = pageItems(body).length;
    return {
      ok: true,
      details: `Reached UniFi Site Manager (at least ${visible} site${visible === 1 ? '' : 's'} visible).`,
    };
  }

  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const seen = new Map<string, string | null>();
    let nextToken: string | null = null;
    let pages = 0;
    while (true) {
      const body = await this.fetchDevicesPage(ctx, [], UNIFI_PAGE_SIZE, nextToken);
      for (const group of pageItems(body)) {
        const hostId = readString(group, ['hostId', 'host_id']);
        if (!hostId) continue;
        if (!seen.has(hostId)) {
          const hostName = readString(group, ['hostName', 'host_name']);
          seen.set(hostId, hostName ?? null);
        }
      }
      nextToken = pageNextToken(body);
      pages += 1;
      if (!nextToken || pages >= 1_000) break;
    }

    const out: SourceOrgDto[] = [];
    for (const [hostId, hostName] of seen) {
      out.push({
        externalId: hostId,
        name: hostName ?? hostId,
        hint: hostName ? null : 'Host name not reported',
      });
    }
    return out;
  }

  async listSourceFields(
    ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
  ): Promise<SourceFieldDto[]> {
    const resourceKey = ctx.resourceKey || UNIFI_RESOURCE_DEVICES;
    if (resourceKey === UNIFI_RESOURCE_CLIENTS) {
      return this.listClientSourceFields();
    }
    return this.listDeviceSourceFields(ctx);
  }

  async fetchRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<DriverFetchPage> {
    const resourceKey = ctx.resourceKey || UNIFI_RESOURCE_DEVICES;
    if (resourceKey === UNIFI_RESOURCE_CLIENTS) {
      return this.fetchClientsRecords(ctx, cursor);
    }
    return this.fetchDeviceRecords(ctx, cursor);
  }

  // -------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------

  private async fetchDeviceRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<DriverFetchPage> {
    const filter = unifiFilterSchema.parse(ctx.filter ?? {});
    const body = await this.fetchDevicesPage(
      ctx,
      [ctx.externalOrgId],
      UNIFI_PAGE_SIZE,
      cursor,
    );

    const records: DriverRecord[] = [];
    for (const group of pageItems(body)) {
      const hostId = readString(group, ['hostId', 'host_id']);
      if (hostId !== ctx.externalOrgId) continue;
      const hostName = readString(group, ['hostName', 'host_name']);
      const hostUpdatedAt = readString(group, ['updatedAt', 'updated_at']);
      for (const device of group.devices ?? []) {
        const record = this.toDeviceRecord(device, {
          hostId: hostId ?? null,
          hostName: hostName ?? null,
          hostUpdatedAt: hostUpdatedAt ?? null,
        });
        if (!record) continue;
        if (matchesFilter(record.fields, filter)) records.push(record);
      }
    }

    const nextToken = pageNextToken(body);
    return {
      records,
      hasMore: nextToken !== null,
      cursor: nextToken,
    };
  }

  private async listDeviceSourceFields(
    ctx: IntegrationContext & { externalOrgId: string },
  ): Promise<SourceFieldDto[]> {
    if (!ctx.externalOrgId) {
      return sortByLabel([...UNIFI_KNOWN_FIELDS]);
    }

    let samples: Record<string, unknown>[] = [];
    try {
      samples = await this.fetchDeviceSamples(ctx, 5);
    } catch (err) {
      this.logger.warn(
        `UniFi listSourceFields probe failed for host ${ctx.externalOrgId}: ${
          (err as Error).message
        } - returning curated catalogue.`,
      );
      return sortByLabel([...UNIFI_KNOWN_FIELDS]);
    }

    if (samples.length === 0) {
      return sortByLabel([...UNIFI_KNOWN_FIELDS]);
    }

    const known = new Map(UNIFI_KNOWN_FIELDS.map((f) => [f.key, f]));
    const seenKeys = new Set<string>();
    for (const sample of samples) {
      for (const key of Object.keys(sample)) seenKeys.add(key);
    }
    for (const key of known.keys()) seenKeys.add(key);

    const out: SourceFieldDto[] = [];
    for (const key of seenKeys) {
      // `id` is the externalId; not user-mappable.
      if (key === 'id') continue;

      const sampleValues: unknown[] = [];
      let nonNullCount = 0;
      for (const sample of samples) {
        const value = sample[key];
        if (value === null || value === undefined || value === '') continue;
        sampleValues.push(value);
        nonNullCount += 1;
      }

      const curated = known.get(key);
      const alwaysPresent =
        samples.length > 0 && nonNullCount === samples.length;
      if (curated) {
        out.push({
          ...curated,
          alwaysPresent: curated.alwaysPresent || alwaysPresent,
        });
      } else {
        out.push({
          key,
          label: humanizeKey(key),
          hintType: inferHintType(sampleValues),
          alwaysPresent,
        });
      }
    }

    return sortByLabel(out);
  }

  private async fetchDeviceSamples(
    ctx: IntegrationContext & { externalOrgId: string },
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const samples: Record<string, unknown>[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    while (samples.length < limit && pages < 5) {
      const body = await this.fetchDevicesPage(
        ctx,
        [ctx.externalOrgId],
        limit,
        nextToken,
      );
      for (const group of pageItems(body)) {
        const hostId = readString(group, ['hostId', 'host_id']);
        if (hostId !== ctx.externalOrgId) continue;
        const hostName = readString(group, ['hostName', 'host_name']);
        for (const device of group.devices ?? []) {
          samples.push(flattenPrimitives(device, {
            hostId: hostId ?? null,
            hostName: hostName ?? null,
          }));
          if (samples.length >= limit) break;
        }
        if (samples.length >= limit) break;
      }
      nextToken = pageNextToken(body);
      pages += 1;
      if (!nextToken) break;
    }
    return samples.slice(0, limit);
  }

  private async fetchDevicesPage(
    ctx: IntegrationContext,
    hostIds: string[],
    pageSize: number,
    cursor: string | null,
  ): Promise<UniFiPage<UniFiHostGroup>> {
    const { baseUrl } = parseConfig(ctx.config);
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/v1/devices`);
    for (const hostId of hostIds) url.searchParams.append('hostIds[]', hostId);
    url.searchParams.set('pageSize', String(pageSize));
    if (cursor) url.searchParams.set('nextToken', cursor);
    return this.callJson<UniFiPage<UniFiHostGroup>>(url.toString(), ctx);
  }

  private toDeviceRecord(
    device: UniFiDevice,
    parent: {
      hostId: string | null;
      hostName: string | null;
      hostUpdatedAt: string | null;
    },
  ): DriverRecord | null {
    const fields = flattenPrimitives(device, {
      hostId: parent.hostId,
      hostName: parent.hostName,
    });
    const externalId = firstString(fields.id, fields.mac);
    if (!externalId) {
      this.logger.warn('UniFi device skipped because it had no stable id.');
      return null;
    }
    return {
      externalId,
      displayName:
        firstString(fields.name, fields.model, fields.shortname, fields.mac) ??
        null,
      fields,
      updatedAt: normalizeTimestamp(
        fields.startupTime ?? fields.adoptionTime ?? parent.hostUpdatedAt,
      ),
    };
  }

  // -------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------

  private listClientSourceFields(): SourceFieldDto[] {
    return sortByLabel([...UNIFI_CLIENT_KNOWN_FIELDS]);
  }

  /**
   * Walk every site under the mapped console and page through each
   * site's clients. The cursor is opaque (base64-encoded JSON) so the
   * runner keeps treating it as a single string, but the driver
   * encodes the multi-site walker state internally:
   *   - on first call (cursor=null) we list sites, then start at
   *     site 0 / offset 0.
   *   - each call returns at most one page of clients (UNIFI_CLIENT_PAGE_SIZE)
   *     and advances `offset`. When a site is exhausted we move to the
   *     next site (offset reset to 0).
   *   - when every site is exhausted we return `hasMore=false`.
   */
  private async fetchClientsRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<DriverFetchPage> {
    const consoleId = ctx.externalOrgId;
    let walker = decodeClientCursor(cursor);
    if (!walker) {
      const sites = await this.listSites(ctx, consoleId);
      walker = {
        siteIds: sites.map((s) => s.id),
        siteNames: Object.fromEntries(sites.map((s) => [s.id, s.name])),
        siteIdx: 0,
        offset: 0,
      };
    }

    while (walker.siteIdx < walker.siteIds.length) {
      const siteId = walker.siteIds[walker.siteIdx]!;
      const siteName = walker.siteNames[siteId] ?? null;
      const page = await this.fetchClientsPage(
        ctx,
        consoleId,
        siteId,
        UNIFI_CLIENT_PAGE_SIZE,
        walker.offset,
      );
      const items = page.data ?? [];
      const records: DriverRecord[] = [];
      for (const client of items) {
        const record = this.toClientRecord(client, {
          consoleId,
          siteId,
          siteName,
        });
        if (record) records.push(record);
      }

      const newOffset: number = walker.offset + items.length;
      const totalCount = Number.isFinite(page.totalCount as number)
        ? Number(page.totalCount)
        : null;
      const siteExhausted =
        items.length === 0 ||
        items.length < UNIFI_CLIENT_PAGE_SIZE ||
        (totalCount !== null && newOffset >= totalCount);

      if (siteExhausted) {
        walker = {
          ...walker,
          siteIdx: walker.siteIdx + 1,
          offset: 0,
        };
      } else {
        walker = { ...walker, offset: newOffset };
      }

      const moreSites = walker.siteIdx < walker.siteIds.length;

      // Yield as soon as we have records on this page — the runner
      // processes one page at a time and calls back for the next. If
      // the page came back empty AND we still have sites/offsets to
      // walk, loop locally so we don't bother the runner with an
      // empty round-trip.
      if (records.length > 0 || !moreSites) {
        return {
          records,
          hasMore: moreSites,
          cursor: moreSites ? encodeClientCursor(walker) : null,
        };
      }
    }

    return { records: [], hasMore: false, cursor: null };
  }

  private async listSites(
    ctx: IntegrationContext,
    consoleId: string,
  ): Promise<Array<{ id: string; name: string | null }>> {
    const { baseUrl } = parseConfig(ctx.config);
    const url = `${baseUrl.replace(
      /\/$/,
      '',
    )}/v1/connector/consoles/${encodeURIComponent(
      consoleId,
    )}/proxy/network/integration/v1/sites`;
    const body = await this.callJson<UniFiOffsetPage<UniFiSite>>(url, ctx);
    const items = Array.isArray(body?.data) ? body.data : [];
    const out: Array<{ id: string; name: string | null }> = [];
    for (const site of items) {
      const id = readString(site, ['id', 'siteId']);
      if (!id) continue;
      const name = readString(site, ['name', 'displayName']);
      out.push({ id, name });
    }
    return out;
  }

  private async fetchClientsPage(
    ctx: IntegrationContext,
    consoleId: string,
    siteId: string,
    limit: number,
    offset: number,
  ): Promise<UniFiOffsetPage<UniFiClient>> {
    const { baseUrl } = parseConfig(ctx.config);
    const url = new URL(
      `${baseUrl.replace(
        /\/$/,
        '',
      )}/v1/connector/consoles/${encodeURIComponent(
        consoleId,
      )}/proxy/network/integration/v1/sites/${encodeURIComponent(
        siteId,
      )}/clients`,
    );
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    return this.callJson<UniFiOffsetPage<UniFiClient>>(url.toString(), ctx);
  }

  private toClientRecord(
    client: UniFiClient,
    parent: {
      consoleId: string;
      siteId: string;
      siteName: string | null;
    },
  ): DriverRecord | null {
    const fields = flattenPrimitives(client, {});
    // The list endpoint exposes `access` as an object — unwrap it to
    // a primitive `accessType` so it can be mapped to a TEXT field
    // without nested-JSON support.
    const access = client.access;
    if (access && typeof access === 'object' && !Array.isArray(access)) {
      const accessType = readString(access as Record<string, unknown>, ['type']);
      if (accessType !== null) fields.accessType = accessType;
    }
    fields.consoleId = parent.consoleId;
    fields.siteId = parent.siteId;
    if (parent.siteName !== null) fields.siteName = parent.siteName;

    const externalId = firstString(fields.id);
    if (!externalId) {
      this.logger.warn('UniFi client skipped because it had no stable id.');
      return null;
    }
    return {
      externalId,
      displayName:
        firstString(fields.name, fields.ipAddress, fields.id) ?? null,
      fields,
      updatedAt: normalizeTimestamp(fields.connectedAt ?? null),
    };
  }

  // -------------------------------------------------------------------
  // HTTP helper (shared)
  // -------------------------------------------------------------------

  private async callJson<T>(url: string, ctx: IntegrationContext): Promise<T> {
    const { apiKey } = unifiSecretSchema.parse(ctx.secret);
    const res = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: 'UniFi Site Manager',
    });

    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        `UniFi GET ${url} returned ${res.status}. Check the API key.`,
      );
    }
    if (!res.ok) {
      throw new Error(`UniFi GET ${url} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

function parseConfig(raw: Record<string, unknown>): { baseUrl: string } {
  return unifiConfigSchema.parse(raw ?? {});
}

function pageItems<T>(body: UniFiPage<T>): T[] {
  return Array.isArray(body?.data) ? body.data : [];
}

function pageNextToken<T>(body: UniFiPage<T>): string | null {
  return firstString(body?.nextToken, body?.next_token);
}

function readString(
  source: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * Flatten an upstream record onto a primitive-only field map. Optional
 * `parent` fields are appended last so the driver can stamp parent
 * context (host / site / console) without it getting overwritten by
 * a same-named primitive on the record itself.
 */
function flattenPrimitives(
  record: Record<string, unknown>,
  parent: Record<string, string | null>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isPrimitive(value)) out[key] = value;
  }
  for (const [key, value] of Object.entries(parent)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1_000;
    return new Date(ms).toISOString();
  }
  return null;
}

function matchesFilter(
  fields: Record<string, unknown>,
  filter: z.infer<typeof unifiFilterSchema>,
): boolean {
  if (filter.productLines?.length) {
    const productLine = firstString(fields.productLine);
    if (!productLine || !filter.productLines.includes(productLine)) return false;
  }
  if (filter.managedOnly) {
    const isManaged = fields.isManaged;
    if (!(isManaged === true || isManaged === 'true')) return false;
  }
  return true;
}

function encodeClientCursor(state: UniFiClientCursor): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

function decodeClientCursor(cursor: string | null): UniFiClientCursor | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as UniFiClientCursor;
    if (
      Array.isArray(parsed.siteIds) &&
      typeof parsed.siteIdx === 'number' &&
      typeof parsed.offset === 'number'
    ) {
      return {
        siteIds: parsed.siteIds,
        siteNames: parsed.siteNames ?? {},
        siteIdx: parsed.siteIdx,
        offset: parsed.offset,
      };
    }
  } catch {
    // Invalid cursor — fall back to a fresh walk.
  }
  return null;
}

const UNIFI_KNOWN_FIELDS: SourceFieldDto[] = [
  { key: 'name', label: 'Device name', hintType: 'TEXT', alwaysPresent: true },
  { key: 'model', label: 'Model', hintType: 'TEXT', alwaysPresent: true },
  { key: 'shortname', label: 'Short name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'mac', label: 'MAC address', hintType: 'TEXT', alwaysPresent: true },
  { key: 'ip', label: 'IP address', hintType: 'IP_ADDRESS', alwaysPresent: false },
  {
    key: 'productLine',
    label: 'Product line',
    hintType: 'TEXT',
    alwaysPresent: false,
  },
  { key: 'status', label: 'Status', hintType: 'TEXT', alwaysPresent: false },
  { key: 'version', label: 'Firmware version', hintType: 'TEXT', alwaysPresent: false },
  {
    key: 'firmwareStatus',
    label: 'Firmware status',
    hintType: 'TEXT',
    alwaysPresent: false,
  },
  {
    key: 'updateAvailable',
    label: 'Update available',
    hintType: 'TEXT',
    alwaysPresent: false,
  },
  {
    key: 'isConsole',
    label: 'Is console',
    hintType: 'BOOLEAN',
    alwaysPresent: false,
  },
  {
    key: 'isManaged',
    label: 'Is managed',
    hintType: 'BOOLEAN',
    alwaysPresent: false,
  },
  {
    key: 'startupTime',
    label: 'Last boot',
    hintType: 'DATETIME',
    alwaysPresent: false,
  },
  {
    key: 'adoptionTime',
    label: 'Adopted at',
    hintType: 'DATETIME',
    alwaysPresent: false,
  },
  { key: 'note', label: 'Note', hintType: 'TEXT', alwaysPresent: false },
  { key: 'hostId', label: 'Host ID', hintType: 'TEXT', alwaysPresent: false },
  { key: 'hostName', label: 'Host name', hintType: 'TEXT', alwaysPresent: false },
];

/**
 * Curated catalogue for the UniFi Network Integration API client list
 * endpoint (`GET /sites/{siteId}/clients`). The list endpoint exposes
 * a deliberately small field set; richer fields like `macAddress`
 * live on the per-client detail endpoint and require an extra HTTP
 * call per client per sync, which we deliberately avoid (operators
 * use `name` / `ipAddress` / `siteId` for the first-claim match key
 * and the sync record's UUID binding for everything thereafter).
 */
const UNIFI_CLIENT_KNOWN_FIELDS: SourceFieldDto[] = [
  { key: 'name', label: 'Client name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'type', label: 'Connection type', hintType: 'TEXT', alwaysPresent: true },
  {
    key: 'ipAddress',
    label: 'IP address',
    hintType: 'IP_ADDRESS',
    alwaysPresent: false,
  },
  {
    key: 'connectedAt',
    label: 'Connected at',
    hintType: 'DATETIME',
    alwaysPresent: false,
  },
  {
    key: 'accessType',
    label: 'Access type',
    hintType: 'TEXT',
    alwaysPresent: false,
  },
  { key: 'siteId', label: 'UniFi site ID', hintType: 'TEXT', alwaysPresent: true },
  { key: 'siteName', label: 'UniFi site name', hintType: 'TEXT', alwaysPresent: false },
  {
    key: 'consoleId',
    label: 'UniFi console ID',
    hintType: 'TEXT',
    alwaysPresent: true,
  },
];
