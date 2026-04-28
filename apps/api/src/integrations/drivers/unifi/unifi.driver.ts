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
 * UniFi Site Manager driver.
 *
 * The Site Manager API exposes hosts (consoles) and devices managed by
 * those hosts. From a Weavestream point of view a single host is a
 * "site": its `hostName` is the human-readable label the operator sees,
 * its `hostId` is the stable identifier used to filter devices.
 *
 * `/v1/sites` exists but its `name` / `meta.name` fields are typically
 * the slug "default" with no friendly label, so we don't call it.
 * `/v1/devices` returns the same hosts as `/v1/hosts` PLUS the host's
 * devices nested inside, which is exactly the shape we need for both
 * source-org enumeration and per-host record fetching.
 *
 * Auth: API key in `X-API-Key`.
 * Pagination: opaque `nextToken` cursor + `pageSize` query parameter.
 *
 * Response envelope (every endpoint):
 *   { data: [...], httpStatusCode, traceId, nextToken?: string|null }
 *
 * Per-host group shape (from `/v1/devices`):
 *   {
 *     hostId: "...",
 *     hostName: "Jaffe Chiropractic",
 *     updatedAt: "2026-04-26T04:10:17Z",
 *     devices: [ { id, mac, name, model, ip, status, version, ... } ]
 *   }
 */

const UNIFI_DEFAULT_BASE_URL = 'https://api.ui.com';
const UNIFI_PAGE_SIZE = 200;

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

export class UniFiSiteManagerDriver implements IntegrationDriver {
  private readonly logger = new Logger(UniFiSiteManagerDriver.name);
  readonly key = 'unifi';

  readonly descriptor: DriverDescriptor = {
    key: 'unifi',
    label: 'UniFi Site Manager',
    description:
      'Sync UniFi Site Manager devices from mapped UniFi sites into Weavestream asset layouts.',
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
    capabilities: {
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

  async fetchRecords(
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
        const record = this.toDriverRecord(device, {
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
          samples.push(flattenDeviceFields(device, {
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

  private toDriverRecord(
    device: UniFiDevice,
    parent: {
      hostId: string | null;
      hostName: string | null;
      hostUpdatedAt: string | null;
    },
  ): DriverRecord | null {
    const fields = flattenDeviceFields(device, {
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

function flattenDeviceFields(
  device: UniFiDevice,
  parent: { hostId: string | null; hostName: string | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(device)) {
    if (isPrimitive(value)) out[key] = value;
  }
  if (parent.hostId !== null) out.hostId = parent.hostId;
  if (parent.hostName !== null) out.hostName = parent.hostName;
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
