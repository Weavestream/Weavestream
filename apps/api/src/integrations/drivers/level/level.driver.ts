import { z } from 'zod';
import type { DriverDescriptor, IntegrationSetupCheck, SourceFieldDto, SourceOrgDto } from '@weavestream/shared';
import {
  DriverAuthError,
  DriverRateLimitError,
  type DriverDiagnoseInput,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
  type LegacyDriverFetchPage,
  type LegacyDriverRecord,
} from '../integration-driver.js';
import { assertRecommendedDestinations, fetchWithRetry } from '../driver-utils.js';
import type { Lookup } from '../section-rows.js';
import { LevelKeyError, diagnoseLevel } from './level.diagnose.js';
import { LEVEL_SETUP_GUIDE } from './level.setup-guide.js';
import {
  buildDeviceSection,
  deviceStandardFields,
  type LevelAlert,
  type LevelDevice,
  type LevelUpdate,
} from './level.sections.js';

/**
 * Level RMM driver (read-only). One integration = one Level account; each
 * top-level group is a source org, and its devices (nested groups
 * included) sync into one company. Every call is a GET with the raw API
 * key in `Authorization` (Level uses no Bearer prefix). Records carry the
 * name, the serial number and the standard facts (LEVEL_STANDARD_FIELDS)
 * that fill layout fields; the extras go into the section.
 *
 * Active alerts and available updates are listed once per org and run,
 * then bucketed by device; a 403/404 there (plan or key permission)
 * becomes a note on each device instead of failing the sync.
 */

export const LEVEL_API = 'https://api.level.io/v2';
const PAGE_LIMIT = 100;
const MAX_PAGES = 1_000;
/** Most alerts or updates held per lookup in one run. */
export const LOOKUP_ITEM_CAP = 50_000;
const RESOURCE = 'devices';

/** Opt-in device details; verified to work on the list call. */
const DEVICE_INCLUDES = [
  'include_operating_system',
  'include_cpus',
  'include_memory',
  'include_disks',
  'include_disk_partitions',
  'include_motherboard',
  'include_network_interfaces',
  'include_security',
] as const;

const secretSchema = z.object({ apiKey: z.string().trim().min(1).max(1_024) });

export const LEVEL_RECOMMENDED_DESTINATIONS = assertRecommendedDestinations('level', {
  [RESOURCE]: {
    layout: { name: 'Devices', slug: 'devices', icon: 'laptop', color: 'teal' },
    fields: [
      { sourceField: 'name', name: 'Name', slug: 'name', fieldType: 'TEXT', syncDirection: 'source_wins', isPrimary: true, showInTable: true, options: {} },
      { sourceField: 'serialNumber', name: 'Serial number', slug: 'serial_number', fieldType: 'TEXT', syncDirection: 'source_wins', isPrimary: false, showInTable: true, options: {} },
    ],
  },
});

/** Standard facts Map layouts offers as layout fields (serial is the match key). */
export const LEVEL_STANDARD_FIELDS: NonNullable<DriverDescriptor['resources'][number]['standardFields']> = [
  { sourceField: 'hostname', label: 'Hostname', fieldType: 'TEXT', fieldHints: ['hostname', 'host_name', 'computer_name'] },
  { sourceField: 'manufacturer', label: 'Manufacturer', fieldType: 'TEXT', fieldHints: ['manufacturer', 'make', 'vendor'] },
  { sourceField: 'model', label: 'Model', fieldType: 'TEXT', fieldHints: ['model'] },
  { sourceField: 'operating_system', label: 'Operating system', fieldType: 'TEXT', fieldHints: ['operating_system', 'os'] },
  { sourceField: 'cpu', label: 'CPU', fieldType: 'TEXT', fieldHints: ['cpu', 'processor'] },
  { sourceField: 'ram', label: 'RAM', fieldType: 'TEXT', fieldHints: ['ram', 'memory'] },
  { sourceField: 'storage', label: 'Storage', fieldType: 'TEXT', fieldHints: ['storage', 'disk', 'disks'] },
  { sourceField: 'mac_address', label: 'MAC address', fieldType: 'TEXT', fieldHints: ['mac_address', 'mac'] },
  { sourceField: 'ip_address', label: 'IP address', fieldType: 'IP_ADDRESS', fieldHints: ['ip_address', 'ip', 'private_ip'] },
  { sourceField: 'role', label: 'Role', fieldType: 'TEXT', fieldHints: ['role'] },
];

/** `starting_after` walker state, opaque to the runner. */
const cursorSchema = z.object({ startingAfter: z.string().min(1).max(256) }).strict();

export function encodeCursor(startingAfter: string | undefined): string | null {
  return startingAfter ? Buffer.from(JSON.stringify({ startingAfter }), 'utf8').toString('base64') : null;
}

export function decodeCursor(cursor: string | null): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')));
    return parsed.success ? parsed.data.startingAfter : undefined;
  } catch {
    // A malformed cursor restarts the walk from the first page.
    return undefined;
  }
}

/** Any other non-OK Level response; carries only the status. */
export class LevelRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'LevelRequestError';
  }
}

class LookupTooLargeError extends Error {}

interface Page<T> {
  data?: T[];
  has_more?: boolean;
}

interface LevelGroup {
  id?: string;
  name?: string;
  parent_id?: string | null;
}

function apiKey(ctx: IntegrationContext): string {
  const parsed = secretSchema.safeParse(ctx.secret ?? {});
  if (!parsed.success) throw new DriverAuthError('No Level API key is saved. Paste the key on the Credentials & schedule tab.');
  return parsed.data.apiKey;
}

function url(path: string, params: Record<string, string | undefined>): string {
  const u = new URL(`${LEVEL_API}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** Authenticated GET; never echoes Level's error text, only the status. */
async function levelGet<T>(ctx: IntegrationContext, target: string): Promise<T> {
  const res = await fetchWithRetry(target, {
    method: 'GET',
    headers: { Authorization: apiKey(ctx), Accept: 'application/json' },
    redirect: 'error',
    timeoutMs: ctx.http.timeoutMs,
    maxRetries: ctx.http.maxRetries,
    backoffMs: ctx.http.backoffMs,
    correlationId: ctx.correlationId,
    serviceName: 'Level',
  });
  if (res.ok) return (await res.json()) as T;
  if (res.status === 401) throw new LevelKeyError('Level rejected the API key (HTTP 401). Create a new key in Level and paste it again.', 401);
  if (res.status === 403) throw new LevelKeyError('The Level API key has no access to this data (HTTP 403). Use a key with Read-only access.', 403);
  throw new LevelRequestError(`Level request failed (HTTP ${res.status}).`, res.status);
}

/** Every page of a `starting_after` listing, up to `cap` items. */
async function listAll<T extends { id?: string }>(
  ctx: IntegrationContext,
  path: string,
  params: Record<string, string | undefined>,
  cap = Infinity,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await levelGet<Page<T>>(ctx, url(path, { ...params, limit: String(PAGE_LIMIT), starting_after: after }));
    const items = Array.isArray(body.data) ? body.data : [];
    out.push(...items);
    if (out.length > cap) {
      throw new LookupTooLargeError(`Not shown: the account has more than ${cap.toLocaleString('en-US')} entries, above what one sync holds.`);
    }
    if (body.has_more !== true) break;
    after = lastId(items);
  }
  return out;
}

/** Id to continue after; a page that says more follow but has no ids must not end the walk silently. */
function lastId(items: Array<{ id?: string }>): string {
  const id = [...items].reverse().find((item) => item.id)?.id;
  if (!id) throw new LevelRequestError('Level returned a page without ids while saying more pages follow.', 502);
  return id;
}

async function rootGroups(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
  // Level answers `parent_id=null` with 404 (it reads "null" as an id), so list
  // every group and keep the roots here.
  const groups = await listAll<LevelGroup>(ctx, '/groups', {});
  return groups
    .filter((g) => g.id && (g.parent_id === null || g.parent_id === undefined))
    .map((g) => ({ externalId: g.id!, name: g.name || g.id!, hint: null }));
}

// ponytail: single process, per run. Keyed by integration + snapshot + org so
// every page of one org shares one fetch; evicted when the org finishes.
const RUN_CACHE_TTL_MS = 15 * 60_000;
const runCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

/** @internal only `*.spec.ts` should call this. */
export function __resetLevelRunCacheForTests(): void {
  runCache.clear();
}

function runKey(ctx: FetchRecordsContext, snapshotAt: string): string {
  return `${ctx.integrationId ?? ctx.correlationId}\0${snapshotAt}\0${ctx.externalOrgId}\0`;
}

function runCached<T>(ctx: FetchRecordsContext, snapshotAt: string, name: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [key, entry] of runCache) if (entry.expiresAt <= now) runCache.delete(key);
  const key = runKey(ctx, snapshotAt) + name;
  const hit = runCache.get(key);
  if (hit) return hit.value as Promise<T>;
  const value = load();
  runCache.set(key, { expiresAt: now + RUN_CACHE_TTL_MS, value });
  // A failed load is not cached; the next page retries it.
  value.catch(() => runCache.delete(key));
  return value;
}

function evictRun(ctx: FetchRecordsContext, snapshotAt: string): void {
  const prefix = runKey(ctx, snapshotAt);
  for (const key of runCache.keys()) if (key.startsWith(prefix)) runCache.delete(key);
}

/** Optional data: any failure becomes a note; only a rate limit propagates. */
async function optional<T>(load: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (e) {
    if (e instanceof DriverRateLimitError) throw e;
    if (e instanceof LookupTooLargeError) return { ok: false, reason: e.message };
    if (e instanceof LevelKeyError || (e instanceof LevelRequestError && e.status === 404)) {
      return { ok: false, reason: 'your Level plan or API key does not include this data.' };
    }
    return { ok: false, reason: 'Level did not return this data. It is retried on the next sync.' };
  }
}

export function byDevice<T extends { device_id?: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    if (!item.device_id) continue;
    const bucket = out.get(item.device_id);
    if (bucket) bucket.push(item);
    else out.set(item.device_id, [item]);
  }
  return out;
}

export class LevelDriver implements IntegrationDriver {
  readonly key = 'level';

  readonly recommendedDestinations = LEVEL_RECOMMENDED_DESTINATIONS;

  readonly descriptor: DriverDescriptor = {
    key: 'level',
    label: 'Level RMM',
    description: 'Read-only sync of Level RMM devices: hardware, OS and network facts fill layout fields; status, storage, security, patches and alerts show on the asset page.',
    iconKey: 'level',
    configFields: [],
    secretFields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'password',
        required: true,
        description: 'Level API key (Settings > API keys), Read-only access recommended. Stored AES-256-GCM encrypted; never returned to the UI.',
      },
    ],
    setupGuide: LEVEL_SETUP_GUIDE,
    resources: [
      {
        key: RESOURCE,
        label: 'Devices',
        description: 'Level devices per top-level group, with hardware, storage, OS, network, security, patches and alerts.',
        defaultMatchKeyHint: 'serialNumber',
        targetKind: 'asset',
        targetConfig: {},
        dependsOnResourceKeys: [],
        matchSuggestions: {
          sourceField: 'serialNumber',
          layoutHints: ['workstations', 'computers', 'servers', 'devices', 'configurations', 'laptops'],
          fieldHints: ['serial', 'serial_number', 'serial_no'],
          fieldLabel: 'Serial number',
        },
        minimalFields: ['name', 'serialNumber'],
        standardFields: LEVEL_STANDARD_FIELDS,
      },
    ],
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      ticketing: false,
      reconstructionCompleteness: false,
    },
  };

  diagnose(input: DriverDiagnoseInput): Promise<IntegrationSetupCheck> {
    if (input.mode !== 'connection') {
      return Promise.resolve({ ok: false, passedStepIds: [], failures: [{ stepId: null, message: 'Level has no OAuth app to check.' }] });
    }
    return diagnoseLevel(async () => (await rootGroups(input.ctx)).length);
  }

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    const roots = await rootGroups(ctx);
    return { ok: true, details: `Connected to Level (${roots.length} top-level groups).` };
  }

  listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    return rootGroups(ctx);
  }

  async listSourceFields(): Promise<SourceFieldDto[]> {
    return [
      { key: 'name', label: 'Name', hintType: 'TEXT', alwaysPresent: true },
      { key: 'serialNumber', label: 'Serial number', hintType: 'TEXT', alwaysPresent: false },
      ...LEVEL_STANDARD_FIELDS.map((field) => ({
        key: field.sourceField,
        label: field.label,
        hintType: field.fieldType === 'IP_ADDRESS' ? ('IP_ADDRESS' as const) : ('TEXT' as const),
        alwaysPresent: false,
      })),
    ];
  }

  async fetchRecords(ctx: FetchRecordsContext, cursor: string | null): Promise<LegacyDriverFetchPage> {
    if (ctx.resourceKey !== RESOURCE) throw new Error(`Unknown Level resource: ${ctx.resourceKey}`);
    const snapshotAt = ctx.snapshotAt ?? new Date().toISOString();
    const roots = await runCached(ctx, snapshotAt, 'roots', () => rootGroups(ctx));
    // Tenant isolation: only a top-level group of this account may feed a company.
    if (!roots.some((g) => g.externalId === ctx.externalOrgId)) {
      throw new DriverAuthError('The mapped Level group is not a top-level group of this Level account. Map a group listed under Organizations.');
    }

    const params: Record<string, string | undefined> = {
      ancestor_group_id: ctx.externalOrgId,
      limit: String(PAGE_LIMIT),
      starting_after: decodeCursor(cursor),
    };
    for (const flag of DEVICE_INCLUDES) params[flag] = 'true';
    const body = await levelGet<Page<LevelDevice>>(ctx, url('/devices', params));
    const rawDevices = Array.isArray(body.data) ? body.data : [];
    const devices = rawDevices.filter((d) => d.id);

    const alerts = await runCached(ctx, snapshotAt, 'alerts', () =>
      optional(async () => byDevice(await listAll<LevelAlert>(ctx, '/alerts', { status: 'active' }, LOOKUP_ITEM_CAP))));
    const updates = await runCached(ctx, snapshotAt, 'updates', () =>
      optional(async () => byDevice(await listAll<LevelUpdate>(ctx, '/updates', { status: 'available' }, LOOKUP_ITEM_CAP))));

    const records: LegacyDriverRecord[] = devices
      // Devices outside any group are not synced.
      .filter((d) => d.group_id)
      .map((d) => {
        const name = d.nickname || d.hostname || d.id!;
        return {
          externalId: d.id!,
          displayName: name,
          // No serial (common on VMs): left empty, so the asset is created and bound by Level id.
          fields: { name, serialNumber: d.serial_number || null, ...deviceStandardFields(d) },
          section: buildDeviceSection({ device: d, alerts, updates }),
          updatedAt: null,
        };
      });

    const next = body.has_more === true ? encodeCursor(lastId(rawDevices)) : null;
    if (next === null) evictRun(ctx, snapshotAt);
    return { records, hasMore: next !== null, cursor: next, snapshotAt };
  }
}
