import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
  DriverDescriptor,
  SourceFieldDto,
  SourceOrgDto,
} from '@weavestream/shared';
import {
  DriverAuthError,
  DriverRateLimitError,
  type DriverFetchPage,
  type DriverRecord,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
} from '../integration-driver.js';

/**
 * Phase 11 — Action1 RMM driver.
 *
 * Action1 is a multi-step API:
 *   1. Exchange the Client ID + Client Secret for an OAuth2 access
 *      token via `POST /oauth2/token` (form-encoded client_credentials
 *      flow).
 *   2. List organisations the token has access to via `/organizations`.
 *   3. List managed endpoints per org via
 *      `/endpoints/managed/{org_id}?fields=*`. Pagination via
 *      `from` / `limit`.
 *
 * Secrets stored on the Integration row (UI shows "Client ID" /
 * "Client Secret" — the on-disk keys stayed `apiKey` / `apiSecret`
 * for backwards compatibility with existing rows):
 *   - `apiKey`     — Action1 OAuth2 Client ID
 *   - `apiSecret`  — Action1 OAuth2 Client Secret
 *
 * Config stored on the Integration row:
 *   - `baseUrl`    — defaults to `https://app.action1.com/api/3.0`
 *
 * Per-mapping config (on `IntegrationCompanyMapping`):
 *   - `externalOrgId` — Action1 organisation id (column on the row)
 *   - `filter`       — `{ groups?: string[] }` optional driver filter
 */
const ACTION1_DEFAULT_BASE_URL = 'https://app.action1.com/api/3.0';
const ACTION1_OAUTH_PATH = '/oauth2/token';

const action1ConfigSchema = z.object({
  baseUrl: z.string().url().default(ACTION1_DEFAULT_BASE_URL),
});

const action1SecretSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  apiSecret: z.string().min(1, 'API secret is required'),
});

const action1FilterSchema = z.object({
  groups: z.array(z.string()).optional(),
});

/**
 * Every Action1 collection endpoint returns a `ResultPage` envelope:
 *   { id, type, name, self, items: [...], total_items, limit, next_page, prev_page }
 *
 * Both `total_items` and `limit` come back as strings in their REST
 * docs, so we normalise to numbers when we need them.
 */
interface Action1ResultPage<T> {
  items?: T[];
  total_items?: string | number;
  limit?: string | number;
  next_page?: string | null;
  prev_page?: string | null;
}

interface Action1Org {
  id: string;
  name: string;
  description?: string;
}

/**
 * Action1 returns endpoint properties using its internal column
 * identifiers, which mix casing (uppercase for `OS`, `RAM`, `MAC`,
 * `CPU_*`; lowercase for `disk`, `name`, `serial`, `address`,
 * `last_seen`, etc.). Keep this interface narrow — anything not
 * declared here flows through `[key: string]: unknown` and is
 * still mappable from the field-mapping UI via the live probe.
 */
interface Action1Endpoint {
  id: string;
  name?: string;
  OS?: string;
  platform?: string;
  address?: string;
  MAC?: string;
  last_seen?: string;
  CPU_name?: string;
  CPU_size?: string;
  RAM?: string;
  disk?: string;
  serial?: string;
  status?: string;
  group?: string;
  [key: string]: unknown;
}

export class Action1Driver implements IntegrationDriver {
  private readonly logger = new Logger(Action1Driver.name);
  readonly key = 'action1';

  readonly descriptor: DriverDescriptor = {
    key: 'action1',
    label: 'Action1 RMM',
    description:
      'Sync managed endpoints from Action1 organisations into Weavestream asset layouts.',
    iconKey: 'action1',
    configFields: [
      {
        key: 'baseUrl',
        label: 'API Base URL',
        kind: 'url',
        required: false,
        description: 'Override only if Action1 has provisioned a custom region.',
        default: ACTION1_DEFAULT_BASE_URL,
      },
    ],
    secretFields: [
      {
        key: 'apiKey',
        label: 'Client ID',
        kind: 'text',
        required: true,
        description:
          'Action1 OAuth2 Client ID. Generate it under Settings → API & Integrations.',
      },
      {
        key: 'apiSecret',
        label: 'Client Secret',
        kind: 'password',
        required: true,
        description:
          'Action1 OAuth2 Client Secret. Stored AES-256-GCM encrypted; never returned to the UI.',
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
    const orgs = await this.fetchAllOrgs(ctx);
    return {
      ok: true,
      details: `Reached Action1 (${orgs.length} organisations).`,
    };
  }

  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const orgs = await this.fetchAllOrgs(ctx);
    return orgs.map((o) => ({
      externalId: o.id,
      name: o.name,
      hint: o.description ?? null,
    }));
  }

  /**
   * Walks every page of `/organizations` and returns the flattened
   * list. Action1 paginates collections via `from`/`limit`, surfacing
   * pagination cursors in `next_page`. We keep paging while
   * `next_page` is non-empty and we keep receiving items.
   */
  private async fetchAllOrgs(ctx: IntegrationContext): Promise<Action1Org[]> {
    const { baseUrl } = parseConfig(ctx.config);
    const token = await this.getAccessToken(ctx);

    const limit = 200;
    const out: Action1Org[] = [];
    let from = 0;
    while (true) {
      const url = new URL(`${baseUrl}/organizations`);
      url.searchParams.set('from', String(from));
      url.searchParams.set('limit', String(limit));
      const body = await this.callJson<Action1ResultPage<Action1Org>>(
        url.toString(),
        { token, ctx },
      );
      const items = Array.isArray(body?.items) ? body.items : [];
      out.push(...items);
      if (items.length < limit) break;
      const total = parseIntOrNull(body?.total_items);
      if (total !== null && out.length >= total) break;
      from += items.length;
      // Hard stop guard so a misbehaving tenant can never pin the API.
      if (from > 10_000) break;
    }
    return out;
  }

  /**
   * Probes Action1 for the *real* endpoint schema so the field-mapping
   * UI exposes everything the tenant's agent reports — vendor, model,
   * serial number, MAC address, agent version, last reboot, etc. —
   * not just the curated subset hard-coded below.
   *
   * Implementation:
   *  1. Pull a small sample (5 records) from
   *     `/endpoints/managed/{org_id}?fields=*`. With `fields=*` Action1
   *     returns every column its agent exports for that endpoint.
   *  2. Union all top-level keys across the sample. Skip nested
   *     objects/arrays — those can't be projected onto a primitive
   *     `AssetField` (we may add TAGS support for string arrays later).
   *  3. For each key, prefer the curated label / hint-type if present;
   *     otherwise infer the type from the sample values and humanise
   *     the snake_case key into a label.
   *  4. If the probe fails (no creds, empty org, network blip), fall
   *     back to the curated catalogue so the UI is never empty.
   */
  async listSourceFields(
    ctx: IntegrationContext & { externalOrgId: string },
  ): Promise<SourceFieldDto[]> {
    if (!ctx.externalOrgId) {
      return sortByLabel([...ACTION1_KNOWN_FIELDS]);
    }

    let samples: Action1Endpoint[] = [];
    try {
      samples = await this.fetchEndpointSamples(ctx, 5);
    } catch (err) {
      this.logger.warn(
        `Action1 listSourceFields probe failed for org ${ctx.externalOrgId}: ${
          (err as Error).message
        } — returning curated catalogue.`,
      );
      return sortByLabel([...ACTION1_KNOWN_FIELDS]);
    }

    if (samples.length === 0) {
      // Empty org → we can't observe the live schema, so the curated
      // set is the best we can offer.
      return sortByLabel([...ACTION1_KNOWN_FIELDS]);
    }

    const known = new Map(ACTION1_KNOWN_FIELDS.map((f) => [f.key, f]));
    const seenKeys = new Set<string>();
    for (const r of samples) {
      for (const k of Object.keys(r ?? {})) seenKeys.add(k);
    }
    // Always include curated keys even if absent in the sample — they
    // may legitimately be null on these specific endpoints but real on
    // others in the org.
    for (const k of known.keys()) seenKeys.add(k);

    const out: SourceFieldDto[] = [];
    for (const key of seenKeys) {
      // `id` is the externalId — handled separately by the sync
      // record, never user-mappable.
      if (key === 'id') continue;

      const sampleValues: unknown[] = [];
      let nonNullCount = 0;
      for (const r of samples) {
        const v = (r as Record<string, unknown>)[key];
        if (v === null || v === undefined || v === '') continue;
        sampleValues.push(v);
        nonNullCount += 1;
      }

      // Skip nested objects & arrays — operators can't usefully map
      // them onto primitive AssetFields, and silently flattening
      // would surprise people.
      if (
        sampleValues.some(
          (v) => typeof v === 'object' && v !== null && !(v instanceof Date),
        )
      ) {
        continue;
      }

      const curated = known.get(key);
      const alwaysPresent =
        samples.length > 0 && nonNullCount === samples.length;

      if (curated) {
        out.push({
          ...curated,
          // Promote `alwaysPresent` if the live probe confirms it; we
          // never demote (the curated copy is the authoritative tenant-
          // independent assertion).
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

  private async fetchEndpointSamples(
    ctx: IntegrationContext & { externalOrgId: string },
    limit: number,
  ): Promise<Action1Endpoint[]> {
    const { baseUrl } = parseConfig(ctx.config);
    const token = await this.getAccessToken(ctx);
    const url = new URL(
      `${baseUrl}/endpoints/managed/${encodeURIComponent(ctx.externalOrgId)}`,
    );
    url.searchParams.set('fields', '*');
    url.searchParams.set('from', '0');
    url.searchParams.set('limit', String(limit));
    const body = await this.callJson<Action1ResultPage<Action1Endpoint>>(
      url.toString(),
      { token, ctx },
    );
    return Array.isArray(body?.items) ? body.items : [];
  }

  async fetchRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<DriverFetchPage> {
    const { baseUrl } = parseConfig(ctx.config);
    const token = await this.getAccessToken(ctx);
    const filter = action1FilterSchema.parse(ctx.filter ?? {});

    const limit = 200;
    const from = cursor ? Number.parseInt(cursor, 10) : 0;
    if (Number.isNaN(from) || from < 0) {
      throw new Error(`Invalid Action1 fetch cursor: ${cursor}`);
    }

    const url = new URL(
      `${baseUrl}/endpoints/managed/${encodeURIComponent(ctx.externalOrgId)}`,
    );
    url.searchParams.set('fields', '*');
    url.searchParams.set('from', String(from));
    url.searchParams.set('limit', String(limit));

    const body = await this.callJson<Action1ResultPage<Action1Endpoint>>(
      url.toString(),
      { token, ctx },
    );

    const raw = Array.isArray(body?.items) ? body.items : [];

    const filtered = filter.groups?.length
      ? raw.filter((e) => filter.groups!.includes(String(e.group ?? '')))
      : raw;

    const records: DriverRecord[] = filtered.map((e) => ({
      externalId: String(e.id),
      // Action1's authoritative display label is `name` (the column
      // their UI shows in the endpoints list). Older versions of this
      // driver tried `hostname` first — that key isn't part of the
      // Action1 schema, so it always fell through to `name` anyway.
      displayName: e.name ? String(e.name) : null,
      fields: { ...e } as Record<string, unknown>,
      updatedAt: typeof e.last_seen === 'string' ? e.last_seen : null,
    }));

    const fetchedSoFar = from + raw.length;
    const total = parseIntOrNull(body?.total_items) ?? fetchedSoFar;
    const hasMore = raw.length >= limit && fetchedSoFar < total;

    return {
      records,
      hasMore,
      cursor: hasMore ? String(fetchedSoFar) : null,
    };
  }

  // -------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------

  private async getAccessToken(ctx: IntegrationContext): Promise<string> {
    const { baseUrl } = parseConfig(ctx.config);
    const { apiKey, apiSecret } = action1SecretSchema.parse(ctx.secret);

    // Action1's token endpoint sits UNDER the API base
    // (e.g. https://app.action1.com/api/3.0/oauth2/token), not at the
    // origin root. Earlier versions stripped `/api/3.0` here, which
    // produced a 403 against the wrong host path.
    const tokenUrl = `${baseUrl.replace(/\/$/, '')}${ACTION1_OAUTH_PATH}`;

    // Action1's docs show only `client_id` + `client_secret` in the
    // form body — `grant_type` is implicit. We follow their cURL
    // example verbatim to avoid any surprise rejections.
    const body = new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
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
    });

    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        `Action1 token exchange failed (${res.status}). Check the Client ID and Client Secret.`,
      );
    }
    if (!res.ok) {
      throw new Error(`Action1 token exchange returned HTTP ${res.status}`);
    }

    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new DriverAuthError(
        'Action1 token exchange did not return access_token.',
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
    });

    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        `Action1 GET ${url} returned ${res.status}. Token rejected.`,
      );
    }
    if (!res.ok) {
      throw new Error(`Action1 GET ${url} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

function parseConfig(raw: Record<string, unknown>): { baseUrl: string } {
  return action1ConfigSchema.parse(raw ?? {});
}

interface FetchOpts {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  correlationId: string;
}

/**
 * Fetch with exponential-backoff retry on 429 + 5xx, honouring the
 * `Retry-After` header on rate-limit responses. Throws
 * `DriverRateLimitError` if the budget is exhausted while still rate
 * limited so the worker can pause the mapping cleanly.
 */
async function fetchWithRetry(
  url: string,
  opts: FetchOpts,
): Promise<Response> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= opts.maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      if (res.status === 429) {
        const retryAfterRaw = res.headers.get('Retry-After');
        const retryAfterMs = parseRetryAfter(retryAfterRaw, opts.backoffMs * 2 ** attempt);
        if (attempt === opts.maxRetries) {
          throw new DriverRateLimitError(
            `Action1 rate limited after ${opts.maxRetries + 1} attempts`,
            retryAfterMs,
          );
        }
        await sleep(retryAfterMs);
        attempt += 1;
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt === opts.maxRetries) return res;
        await sleep(opts.backoffMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e instanceof DriverRateLimitError) throw e;
      if (attempt === opts.maxRetries) break;
      await sleep(opts.backoffMs * 2 ** attempt);
      attempt += 1;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Action1 request failed: ${String(lastErr)}`);
}

function parseRetryAfter(raw: string | null, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds)) return seconds * 1_000;
  const date = new Date(raw).getTime();
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Action1 returns numeric paging fields (`total_items`, `limit`) as
 * strings in some endpoints and numbers in others. Normalise to a
 * non-negative integer or null when the value is missing/garbled so
 * pagination logic can branch on a real number.
 */
function parseIntOrNull(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Curated field catalogue for Action1 managed endpoints.
 *
 * Two roles:
 *   1. Authoritative override for label + hintType when the live
 *      probe surfaces these keys (so e.g. `last_seen` is always
 *      labelled "Last seen" with `DATETIME`, not whatever the auto
 *      humaniser would emit).
 *   2. Fallback list when the live probe can't run (no org, empty
 *      org, network blip).
 *
 * IMPORTANT — Action1's JSON keys are CASE-SENSITIVE and follow the
 * column identifiers used by their internal data model. Some are
 * uppercase (`OS`, `RAM`, `MAC`, `CPU_name`), some lowercase
 * (`disk`, `name`, `serial`, `address`). We keep the keys here
 * EXACTLY as the API returns them — using `os` / `ram` instead of
 * `OS` / `RAM` was the original Phase 11 bug that left fields blank
 * after sync because `record.fields[fm.sourceField]` resolved to
 * `undefined`.
 *
 * The live probe will surface MANY more fields than these — agent_version,
 * last_reboot, vendor, model, etc. — by walking `?fields=*`. We don't
 * try to enumerate every Action1 column here because the set varies
 * by agent version and tenant configuration.
 */
const ACTION1_KNOWN_FIELDS: SourceFieldDto[] = [
  { key: 'name', label: 'Endpoint name', hintType: 'TEXT', alwaysPresent: true },
  { key: 'OS', label: 'Operating system', hintType: 'TEXT', alwaysPresent: true },
  { key: 'platform', label: 'Platform', hintType: 'TEXT', alwaysPresent: false },
  { key: 'address', label: 'IP address', hintType: 'IP_ADDRESS', alwaysPresent: false },
  { key: 'MAC', label: 'MAC address', hintType: 'TEXT', alwaysPresent: false },
  { key: 'last_seen', label: 'Last seen', hintType: 'DATETIME', alwaysPresent: false },
  { key: 'CPU_name', label: 'CPU', hintType: 'TEXT', alwaysPresent: false },
  { key: 'CPU_size', label: 'CPU size', hintType: 'TEXT', alwaysPresent: false },
  { key: 'RAM', label: 'RAM', hintType: 'TEXT', alwaysPresent: false },
  { key: 'disk', label: 'Disk', hintType: 'TEXT', alwaysPresent: false },
  { key: 'serial', label: 'Serial number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'agent_version', label: 'Agent version', hintType: 'TEXT', alwaysPresent: false },
  { key: 'status', label: 'Status', hintType: 'TEXT', alwaysPresent: false },
  { key: 'user', label: 'Logged-in user', hintType: 'TEXT', alwaysPresent: false },
  { key: 'reboot_required', label: 'Reboot required', hintType: 'BOOLEAN', alwaysPresent: false },
  { key: 'group', label: 'Endpoint group', hintType: 'TEXT', alwaysPresent: false },
];

/**
 * Heuristically infers the most-likely Weavestream field type for an
 * Action1 column we don't have in the curated catalogue. We never
 * promise the inference is perfect — `hintType` only drives the
 * "suggested target" UI, the operator still picks the final mapping.
 */
function inferHintType(values: unknown[]): SourceFieldDto['hintType'] {
  const first = values.find((v) => v !== null && v !== undefined);
  if (first === undefined) return 'TEXT';
  if (typeof first === 'boolean') return 'BOOLEAN';
  if (typeof first === 'number') return 'NUMBER';
  if (typeof first === 'string') {
    const s = first;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return 'DATETIME';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'DATE';
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return 'EMAIL';
    if (/^https?:\/\/\S+$/i.test(s)) return 'URL';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return 'IP_ADDRESS';
    return 'TEXT';
  }
  return 'TEXT';
}

/**
 * `snake_case_key` → `Snake Case Key`, with a couple of well-known
 * acronyms upper-cased so the dropdown reads naturally.
 */
function humanizeKey(key: string): string {
  const titled = key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return titled
    .replace(/\bIp\b/g, 'IP')
    .replace(/\bIpv6\b/g, 'IPv6')
    .replace(/\bOs\b/g, 'OS')
    .replace(/\bCpu\b/g, 'CPU')
    .replace(/\bRam\b/g, 'RAM')
    .replace(/\bMac\b/g, 'MAC')
    .replace(/\bDns\b/g, 'DNS')
    .replace(/\bUuid\b/g, 'UUID')
    .replace(/\bId\b/g, 'ID')
    .replace(/\bUrl\b/g, 'URL');
}

function sortByLabel(fields: SourceFieldDto[]): SourceFieldDto[] {
  return [...fields].sort((a, b) => a.label.localeCompare(b.label));
}
