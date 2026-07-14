import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
  DriverDescriptor,
  SourceFieldDto,
  SourceOrgDto,
  TicketActivityDto,
  TicketActivityKind,
  TicketDetailDto,
  TicketListDto,
  TicketListFilter,
  TicketListResponse,
  TicketPriority,
  TicketStatusBucket,
} from '@weavestream/shared';
import {
  DriverAuthError,
  type LegacyDriverFetchPage,
  type LegacyDriverRecord,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
  type TicketContext,
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
// NinjaOne OAuth2 client_credentials scopes. We always try the full
// set first (monitoring + ticketing). If the API client wasn't granted
// `ticketing`, NinjaOne replies 400 invalid_scope and we transparently
// fall back to the legacy `monitoring`-only token so the pre-existing
// sync flow keeps working — ticketing endpoints will then return
// empty / 403 and the UI surfaces a clean "no boards" message.
const NINJAONE_OAUTH_FULL_SCOPE = 'monitoring ticketing';
const NINJAONE_OAUTH_FALLBACK_SCOPE = 'monitoring';
/**
 * Resource keys this driver advertises. The orchestrator fans out one
 * sync job per `(mapping, resource)` pair, so any stale row with a
 * key not in this set would silently double-process every device.
 * `assertExpectedResourceKey` hard-fails on anything else.
 *
 * `records` — agented devices (Windows / Linux / macOS workstations
 *   and servers with the NinjaOne agent installed). The kept-for-
 *   backward-compat key on tenants who installed the integration
 *   before the multi-resource split landed.
 * `nms`     — NMS-discovered + virtualisation-sourced devices: SNMP
 *   network gear (switches / firewalls / printers / VoIP), VMware /
 *   Hyper-V / Xen guest VMs and host management nodes, and anything
 *   else NinjaOne tracks without a local agent. Optional — operators
 *   pick a layout + match keys + field mappings for this resource
 *   only when they actually want non-agent devices in Weavestream.
 */
const NINJAONE_AGENT_RESOURCE_KEY = 'records';
const NINJAONE_NMS_RESOURCE_KEY = 'nms';
const NINJAONE_RESOURCE_KEYS = new Set<string>([
  NINJAONE_AGENT_RESOURCE_KEY,
  NINJAONE_NMS_RESOURCE_KEY,
]);

/** NinjaOne's `deviceType` value for agented devices. */
const NINJAONE_AGENT_DEVICE_TYPE = 'AgentDevice';

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

/**
 * Process-wide OAuth token cache. Keyed by either the Weavestream
 * `integrationId` (preferred — stable across config edits when only
 * unrelated fields change) OR a `${baseUrl}::${apiKey}` fingerprint
 * for callers that don't plumb the integration id through
 * (`testConnection` from the global admin UI, driver tests).
 *
 * NinjaOne tokens are valid for an hour; we expire on a ~50-minute
 * TTL so a request right at the edge still has runway to complete.
 * A 401 from any downstream NinjaOne call invalidates the cached
 * token and the next request mints a fresh one — handles the case
 * where the secret was rotated server-side without a Weavestream
 * config push.
 */
interface CachedToken {
  token: string;
  expiresAt: number;
  /** Fingerprint of the (baseUrl + apiKey + apiSecret) tuple that
   * produced this token, so a credential change invalidates without
   * waiting for the TTL. */
  fingerprint: string;
}
const NINJAONE_TOKEN_TTL_MS = 50 * 60 * 1_000;
const ninjaoneTokenCache = new Map<string, CachedToken>();

/**
 * Test-only helper: drop every cached OAuth token. Production code
 * MUST NOT call this — the cache is keyed so that production
 * concurrent callers benefit from a single live access token.
 *
 * @internal — only `*.spec.ts` should import this.
 */
export function __resetNinjaOneTokenCacheForTests(): void {
  ninjaoneTokenCache.clear();
}

function ninjaoneTokenCacheKey(
  ctx: IntegrationContext,
  baseUrl: string,
  apiKey: string,
): string {
  if (ctx.integrationId) return `id:${ctx.integrationId}`;
  return `fp:${baseUrl}::${apiKey}`;
}

function ninjaoneTokenFingerprint(
  baseUrl: string,
  apiKey: string,
  apiSecret: string,
): string {
  // We never log this string; it lives in process memory only. Using
  // a non-cryptographic concat is fine for "did the credential change"
  // — we're not authenticating with it.
  return `${baseUrl}|${apiKey}|${apiSecret.length}|${apiSecret.slice(-4)}`;
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
      // Primary resource — agented endpoints (workstations / servers
      // running the NinjaOne agent). Default match key suggestion is
      // `uid` because IP / systemName are fragile across DHCP churn,
      // multi-NIC, and cross-RMM matching scenarios.
      {
        key: NINJAONE_AGENT_RESOURCE_KEY,
        label: 'Agent devices',
        targetKind: 'asset',
        targetConfig: {},
        dependsOnResourceKeys: [],
        description:
          'Workstations, servers, and other endpoints with the NinjaOne agent installed (Windows, Linux, macOS).',
        defaultMatchKeyHint: 'uid',
      },
      // Optional secondary resource — non-agent devices: NMS (SNMP-
      // discovered switches / firewalls / printers / VoIP), plus
      // VMware / Hyper-V / Xen guest VMs and hypervisor management
      // nodes. Operators configure this resource (layout + match key
      // + field mappings) only when they actively want these devices
      // synced into Weavestream — otherwise it stays disabled and the
      // orchestrator skips it.
      {
        key: NINJAONE_NMS_RESOURCE_KEY,
        label: 'Network & non-agent devices',
        targetKind: 'asset',
        targetConfig: {},
        dependsOnResourceKeys: [],
        description:
          'NMS-discovered network gear (switches, firewalls, printers, VoIP) plus VMware / Hyper-V / Xen guest VMs and hypervisor management nodes — anything NinjaOne tracks without a local agent.',
        defaultMatchKeyHint: 'uid',
      },
    ],
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      // Phase 12 — NinjaOne exposes the optional ticketing surface. The
      // driver gracefully degrades when the tenant doesn't have the
      // Ticketing add-on (404s from `/v2/ticketing/*` map to an empty
      // list / clear "not enabled" error rather than crashing).
      ticketing: true,
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
    assertExpectedResourceKey(ctx.resourceKey);
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
    ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
    sampleSize: number,
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
    // Over-fetch so the post-filter slice still has enough samples on
    // tenants whose org is dominated by one device type (e.g. an MSP
    // that's mostly agented endpoints with a handful of NMS switches —
    // the `nms` probe would get 0 hits with a tight pageSize=5).
    url.searchParams.set('pageSize', String(Math.max(sampleSize * 4, 20)));
    const items = await this.callJson<NinjaOneDevice[]>(url.toString(), {
      token,
      ctx,
    });
    const raw = Array.isArray(items) ? items : [];
    return filterByResource(ctx.resourceKey, raw).slice(0, sampleSize);
  }

  async fetchRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<LegacyDriverFetchPage> {
    assertExpectedResourceKey(ctx.resourceKey);
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

    // Resource branch: the `records` resource only takes agented
    // devices; the `nms` resource takes everything else (NMS gear,
    // VMs, hypervisor management nodes). Stale rows would have
    // already been rejected by `assertExpectedResourceKey` above, so
    // any value reaching here is one of the two known keys.
    const resourceScoped = filterByResource(ctx.resourceKey, orgScoped);

    const filtered = filter.locationIds?.length
      ? resourceScoped.filter(
          (d) =>
            typeof d.locationId === 'number' &&
            filter.locationIds!.includes(d.locationId),
        )
      : resourceScoped;

    const records: LegacyDriverRecord[] = filtered.map((d) => {
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

  /**
   * Returns a valid OAuth2 access token. Reads from the process-wide
   * cache first; mints a new one on miss / expiry / fingerprint change.
   *
   * `forceRefresh` is set internally when a downstream NinjaOne call
   * returned 401 and the caller wants to retry once with a fresh
   * token — see `callJson` below.
   */
  private async getAccessToken(
    ctx: IntegrationContext,
    forceRefresh = false,
  ): Promise<string> {
    const { baseUrl } = parseConfig(ctx.config);
    const { apiKey, apiSecret } = ninjaoneSecretSchema.parse(ctx.secret);

    const cacheKey = ninjaoneTokenCacheKey(ctx, baseUrl, apiKey);
    const fingerprint = ninjaoneTokenFingerprint(baseUrl, apiKey, apiSecret);
    if (!forceRefresh) {
      const cached = ninjaoneTokenCache.get(cacheKey);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        cached.expiresAt > Date.now()
      ) {
        return cached.token;
      }
    }

    const tokenUrl = `${baseUrl.replace(/\/$/, '')}${NINJAONE_OAUTH_PATH}`;

    // Try the full scope set first; on `invalid_scope` fall back to
    // monitoring-only. Two attempts max — if both fail we surface a
    // single DriverAuthError with the upstream body.
    let token = await this.exchangeForToken(
      tokenUrl,
      apiKey,
      apiSecret,
      NINJAONE_OAUTH_FULL_SCOPE,
      ctx,
      cacheKey,
      { failOnInvalidScope: true },
    );
    if (token === null) {
      this.logger.warn(
        `NinjaOne API client lacks the "ticketing" scope (integration ${ctx.integrationId ?? '<unknown>'}); falling back to monitoring-only. Ticket browsing will be empty until the operator enables ticketing on the NinjaOne API client.`,
      );
      token = await this.exchangeForToken(
        tokenUrl,
        apiKey,
        apiSecret,
        NINJAONE_OAUTH_FALLBACK_SCOPE,
        ctx,
        cacheKey,
        { failOnInvalidScope: false },
      );
    }
    if (!token) {
      // Should be unreachable: the second call throws on failure.
      throw new DriverAuthError('NinjaOne token exchange failed.');
    }
    ninjaoneTokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + NINJAONE_TOKEN_TTL_MS,
      fingerprint,
    });
    return token;
  }

  /**
   * Single OAuth2 token exchange round-trip. Returns the token on
   * success, `null` ONLY when `failOnInvalidScope` is true and the
   * upstream responded with `invalid_scope` (so the caller can retry
   * with a narrower scope set). Any other failure throws.
   */
  private async exchangeForToken(
    tokenUrl: string,
    apiKey: string,
    apiSecret: string,
    scope: string,
    ctx: IntegrationContext,
    cacheKey: string,
    opts: { failOnInvalidScope: boolean },
  ): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: apiSecret,
      scope,
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
      ninjaoneTokenCache.delete(cacheKey);
      throw new DriverAuthError(
        `NinjaOne token exchange failed (${res.status}). Check the Client ID, Client Secret, and that the API client has the "monitoring" scope.`,
      );
    }
    if (res.status === 400 && opts.failOnInvalidScope) {
      // Body is JSON: { "error": "invalid_scope", "error_description": "..." }
      const bodyText = await res
        .text()
        .catch(() => '')
        .then((t) => t.slice(0, 500));
      if (/invalid_scope/i.test(bodyText)) {
        return null;
      }
      ninjaoneTokenCache.delete(cacheKey);
      throw new DriverAuthError(
        `NinjaOne token exchange returned HTTP 400${
          bodyText ? `: ${bodyText.slice(0, 200)}` : ''
        }`,
      );
    }
    if (!res.ok) {
      const bodyText = await res
        .text()
        .catch(() => '')
        .then((t) => t.slice(0, 500));
      throw new Error(
        `NinjaOne token exchange returned HTTP ${res.status}${
          bodyText ? `: ${bodyText.slice(0, 200)}` : ''
        }`,
      );
    }

    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new DriverAuthError(
        'NinjaOne token exchange did not return access_token.',
      );
    }
    return json.access_token;
  }

  private invalidateToken(ctx: IntegrationContext): void {
    const { baseUrl } = parseConfig(ctx.config);
    const { apiKey } = ninjaoneSecretSchema.parse(ctx.secret);
    ninjaoneTokenCache.delete(ninjaoneTokenCacheKey(ctx, baseUrl, apiKey));
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
      // Token may have been revoked or expired sooner than our TTL.
      // Drop the cached entry so the next call mints fresh credentials.
      this.invalidateToken(opts.ctx);
      throw new DriverAuthError(
        `NinjaOne GET ${url} returned ${res.status}. Token rejected.`,
      );
    }
    if (!res.ok) {
      throw new Error(`NinjaOne GET ${url} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  // -------------------------------------------------------------------
  // Phase 12 — ticketing surface (read-only)
  // -------------------------------------------------------------------

  /**
   * Lists tickets for a single NinjaOne organisation. NinjaOne returns
   * tickets via a per-board scrolling endpoint
   * (`POST /v2/ticketing/trigger/board/{boardId}/run`), which means
   * we must walk every visible board and union the rows.
   *
   * We scope to the mapped `externalOrgId` via a `clientId` filter on
   * each board's request body so devices from other tenants never leak
   * — the API will silently include all tenants the caller can see if
   * the filter is missing.
   *
   * Pagination is cursor-based but per-board; for simplicity v1 fetches
   * the first page (200 rows) per board and stops there. Subsequent
   * pages are surfaced via the returned cursor (`board-id:lastCursorId`).
   */
  async listTickets(
    ctx: TicketContext,
    filter: TicketListFilter,
    cursor: string | null,
  ): Promise<TicketListResponse> {
    const { baseUrl } = parseConfig(ctx.config);
    const expectedOrgId = parseClientId(ctx.externalOrgId);
    const token = await this.getAccessToken(ctx);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    const boards = await this.fetchTicketBoards(ctx, headers, baseUrl);
    if (boards.length === 0) {
      // Most common cause: the API client in NinjaOne wasn't granted
      // the `ticketing` scope, or the tenant has no boards configured.
      // We log a warning here (no PII) so operators can quickly tell
      // why the list is empty.
      this.logger.warn(
        `NinjaOne returned zero ticketing boards for integration ${ctx.integrationId ?? '<unknown>'} (org ${ctx.externalOrgId ?? 'global'}). Verify the API client has the "ticketing" scope and at least one ticket board exists.`,
      );
      return { records: [], cursor: null };
    }
    this.logger.debug(
      `NinjaOne returned ${boards.length} ticketing board(s) (org ${ctx.externalOrgId ?? 'global'}).`,
    );

    // Restrict to a single board when the operator filtered to one.
    const walkBoards = filter.boardId
      ? boards.filter((b) => String(b.id) === filter.boardId)
      : boards;

    // Pagination cursor: "boardId:lastCursorId". A null cursor starts
    // at the first board. The visible page corresponds 1:1 to one
    // upstream board fetch (~50 rows). When a board is exhausted we
    // advance to the next board on the following click. This is the
    // pattern the user agreed to in the plan ("Call 50 tickets a time
    // by page size") — no internal multi-fetch scanning.
    const PAGE_SIZE = 50;
    let resumeBoardId: number | null = null;
    let resumeAfter = 0;
    if (cursor) {
      const m = /^(\d+):(\d+)$/.exec(cursor);
      if (m) {
        resumeBoardId = Number.parseInt(m[1] ?? '', 10);
        resumeAfter = Number.parseInt(m[2] ?? '0', 10);
      }
    }
    let startIndex = 0;
    if (resumeBoardId !== null) {
      const idx = walkBoards.findIndex((b) => b.id === resumeBoardId);
      if (idx >= 0) startIndex = idx;
      else resumeAfter = 0; // Board vanished; resume from first board.
    }

    if (startIndex >= walkBoards.length) {
      return { records: [], cursor: null };
    }

    // Walk forward through boards until we find one with rows (or
    // one that has more pages to come). Empty boards return
    // `{ records: [], exhausted: true }` and would otherwise burn a
    // visible page click on zero rows — common on tenants that have
    // an "Archived" or rarely-used board configured upstream. The
    // upstream call against an empty board is cheap, so eagerly
    // skipping them inside one page request keeps the UI consistent
    // (50 rows per click, near-zero empty pages).
    let bi = startIndex;
    let resumeAt = resumeAfter;
    let page: {
      records: TicketListDto[];
      lastCursorId: number | null;
      exhausted: boolean;
    } | null = null;
    while (bi < walkBoards.length) {
      const board = walkBoards[bi]!;
      const p = await this.fetchBoardPage(
        ctx,
        headers,
        baseUrl,
        board,
        resumeAt,
        PAGE_SIZE,
        filter,
        expectedOrgId,
      );
      if (p.records.length > 0 || !p.exhausted) {
        page = p;
        break;
      }
      bi += 1;
      resumeAt = 0;
    }

    if (!page) {
      return { records: [], cursor: null };
    }

    // Compute the cursor for the next click:
    //  - board has more rows (not exhausted) → resume at same board
    //  - board exhausted → resume at next board (or null when done)
    const pageBoard = walkBoards[bi]!;
    let nextCursor: string | null = null;
    if (!page.exhausted && page.lastCursorId != null) {
      nextCursor = `${pageBoard.id}:${page.lastCursorId}`;
    } else {
      const next = walkBoards[bi + 1];
      nextCursor = next ? `${next.id}:0` : null;
    }

    return { records: page.records, cursor: nextCursor };
  }

  /**
   * Fetches one upstream page from a single board, enriches incomplete
   * rows, applies client-side filtering + IDOR enforcement, and
   * returns the visible records plus the upstream cursor for the next
   * page (if any). Marks the board as exhausted when the upstream
   * returned fewer rows than the requested page size.
   */
  private async fetchBoardPage(
    ctx: TicketContext,
    headers: Record<string, string>,
    baseUrl: string,
    board: { id: number; name: string },
    lastCursorId: number,
    pageSize: number,
    filter: TicketListFilter,
    expectedOrgId: number | null,
  ): Promise<{
    records: TicketListDto[];
    lastCursorId: number | null;
    exhausted: boolean;
  }> {
    // NinjaOne's `/trigger/board/{id}/run` is finicky about the body
    // shape — `filters` with the wrong operator returns HTTP 500.
    // The community-proven minimal body (sortBy + pageSize + optional
    // lastCursorId/searchCriteria) is what we send; all filtering
    // happens client-side.
    const requestBody: Record<string, unknown> = {
      pageSize,
      sortBy: [{ field: 'lastUpdated', direction: 'DESC' }],
      ...(lastCursorId > 0 ? { lastCursorId } : {}),
      ...(filter.search ? { searchCriteria: filter.search } : {}),
    };

    const url = `${baseUrl.replace(/\/$/, '')}/v2/ticketing/trigger/board/${board.id}/run`;
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: 'NinjaOne',
    });

    if (res.status === 401 || res.status === 403) {
      this.invalidateToken(ctx);
      throw new DriverAuthError(
        `NinjaOne ticketing list failed (${res.status}). Token rejected.`,
      );
    }
    if (res.status === 404) {
      return { records: [], lastCursorId: null, exhausted: true };
    }
    if (!res.ok) {
      const bodyText = await res
        .text()
        .catch(() => '')
        .then((t) => t.slice(0, 500));
      this.logger.warn(
        `NinjaOne ticketing list returned HTTP ${res.status} for board ${board.id} (corr=${ctx.correlationId}): ${bodyText}`,
      );
      throw new Error(
        `NinjaOne ticketing list returned HTTP ${res.status}${
          bodyText ? `: ${bodyText.slice(0, 200)}` : ''
        }`,
      );
    }

    const payload = (await res.json()) as {
      data?: Array<Record<string, unknown>>;
      metadata?: { lastCursorId?: number };
    };
    const rows = Array.isArray(payload?.data) ? payload.data : [];

    // Build candidates + flag rows needing canonical enrichment.
    // We enrich whenever subject or clientId is missing — both are
    // required for the UI (subject) AND service-side company
    // resolution (clientId). Per-board "displayed fields"
    // configuration in NinjaOne can omit either.
    type Candidate = {
      row: Record<string, unknown>;
      dto: TicketListDto;
      needsEnrich: boolean;
    };
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const dto = mapNinjaTicketListRow(row, board);
      if (!dto) continue;
      const subjectMissing = dto.subject === '(no subject)';
      const clientIdMissing = dto.externalClientId === null;
      candidates.push({
        row,
        dto,
        needsEnrich: subjectMissing || clientIdMissing,
      });
    }

    // Enrich incomplete rows. NinjaOne rate-limits aggressively, so
    // we cap concurrency at 4 here. Failed enrichments aggregate by
    // failure reason so the operator can see WHY (e.g., 429 rate
    // limit vs missing field on the upstream detail).
    const toEnrich = candidates.filter((c) => c.needsEnrich);
    const failureCounts = new Map<string, number>();
    if (toEnrich.length > 0) {
      const concurrency = 4;
      for (let i = 0; i < toEnrich.length; i += concurrency) {
        const batch = toEnrich.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (c) => {
            const enriched = await this.fetchTicketEnrichment(
              ctx,
              headers,
              baseUrl,
              c.dto.id,
            );
            if ('failure' in enriched) {
              failureCounts.set(
                enriched.failure,
                (failureCounts.get(enriched.failure) ?? 0) + 1,
              );
              return;
            }
            if (enriched.subject) c.dto.subject = enriched.subject;
            if (enriched.clientId !== undefined) {
              c.dto.externalClientId = String(enriched.clientId);
            }
          }),
        );
      }
    }

    // Filter + IDOR enforcement.
    const visible: TicketListDto[] = [];
    let droppedForOrgMismatch = 0;
    for (const { dto } of candidates) {
      // IDOR backstop for the legacy per-company surface: hard-reject
      // rows whose clientId doesn't match the mapped org. In global
      // mode (`expectedOrgId === null`) we keep every row regardless
      // of clientId — the service layer resolves company affiliation
      // for display, never for access control.
      if (expectedOrgId !== null) {
        const rowClientId =
          dto.externalClientId !== null
            ? Number.parseInt(dto.externalClientId, 10)
            : null;
        if (rowClientId === null || rowClientId !== expectedOrgId) {
          droppedForOrgMismatch += 1;
          continue;
        }
      }
      if (filter.status && dto.status !== filter.status) continue;
      if (
        filter.priority &&
        filter.priority !== 'none' &&
        dto.priority !== filter.priority
      ) {
        continue;
      }
      if (
        filter.assigneeId &&
        (dto.assignee?.id ?? null) !== filter.assigneeId
      ) {
        continue;
      }
      visible.push(dto);
    }
    if (droppedForOrgMismatch > 0) {
      this.logger.debug(
        `NinjaOne board ${board.id} dropped ${droppedForOrgMismatch} ticket(s) for org mismatch (expected org ${ctx.externalOrgId ?? 'n/a'}).`,
      );
    }
    if (failureCounts.size > 0) {
      const breakdown = [...failureCounts.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      this.logger.warn(
        `NinjaOne board ${board.id} enrichment failures: ${breakdown} (corr=${ctx.correlationId}).`,
      );
    }

    const exhausted = rows.length < pageSize;
    return {
      records: visible,
      lastCursorId: payload.metadata?.lastCursorId ?? null,
      exhausted,
    };
  }

  /**
   * Lightweight enrichment helper for the list flow. Fetches only the
   * canonical fields needed to render the row and enforce org
   * scoping; does NOT fetch logs. Returns `null` on any failure so
   * the caller can decide to drop the row. Failures bubble up the
   * upstream status code so the caller can aggregate diagnostics.
   */
  private async fetchTicketEnrichment(
    ctx: TicketContext,
    headers: Record<string, string>,
    baseUrl: string,
    ticketId: string,
  ): Promise<
    | { subject: string | null; clientId: number | undefined }
    | { failure: string }
  > {
    const url = `${baseUrl.replace(/\/$/, '')}/v2/ticketing/ticket/${ticketId}`;
    try {
      const res = await fetchWithRetry(url, {
        method: 'GET',
        headers,
        timeoutMs: ctx.http.timeoutMs,
        maxRetries: ctx.http.maxRetries,
        backoffMs: ctx.http.backoffMs,
        correlationId: ctx.correlationId,
        serviceName: 'NinjaOne',
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          this.invalidateToken(ctx);
        }
        return { failure: `http_${res.status}` };
      }
      const json = (await res.json()) as Record<string, unknown>;
      if (!json || typeof json !== 'object') return { failure: 'empty_body' };
      return {
        subject: pickString(json, ['subject', 'summary', 'name', 'title']),
        clientId:
          pickNumber(json, ['clientId', 'clientID', 'organizationId', 'orgId']) ??
          undefined,
      };
    } catch (e) {
      return { failure: e instanceof Error ? e.message.slice(0, 80) : 'unknown' };
    }
  }

  /**
   * Fetches a single ticket's full detail + log entries and projects
   * them onto the canonical TicketDetailDto shape.
   */
  async getTicket(ctx: TicketContext, ticketId: string): Promise<TicketDetailDto> {
    const cleanId = String(ticketId).trim();
    if (!/^\d+$/.test(cleanId)) {
      throw new Error(`Invalid NinjaOne ticket id: ${ticketId}`);
    }
    const { baseUrl } = parseConfig(ctx.config);
    const token = await this.getAccessToken(ctx);
    const expectedOrgId = parseClientId(ctx.externalOrgId);

    const ticketUrl = `${baseUrl.replace(/\/$/, '')}/v2/ticketing/ticket/${cleanId}`;
    const logsUrl = `${baseUrl.replace(/\/$/, '')}/v2/ticketing/ticket/${cleanId}/log-entry`;
    const [ticketRaw, logsRaw] = await Promise.all([
      this.callJson<Record<string, unknown>>(ticketUrl, { token, ctx }),
      this.callJson<Array<Record<string, unknown>>>(logsUrl, {
        token,
        ctx,
      }).catch(() => [] as Array<Record<string, unknown>>),
    ]);

    if (!ticketRaw || typeof ticketRaw !== 'object') {
      throw new Error(`NinjaOne ticket ${cleanId} returned an empty payload`);
    }

    // IDOR backstop: NinjaOne lets the API caller fetch any ticket id
    // by direct URL regardless of the configured org mapping. We
    // reject any ticket whose `clientId` doesn't match the mapping's
    // upstream org so a hand-crafted URL can't leak cross-tenant
    // tickets into the wrong Weavestream company.
    if (expectedOrgId !== null) {
      const rowClientId = pickNumber(ticketRaw, [
        'clientId',
        'clientID',
        'organizationId',
        'orgId',
      ]);
      if (rowClientId === null || rowClientId !== expectedOrgId) {
        throw new DriverAuthError(
          `NinjaOne ticket ${cleanId} belongs to a different organisation than the configured mapping.`,
        );
      }
    }

    const subject =
      pickString(ticketRaw, ['subject', 'summary', 'name', 'title']) ??
      '(no subject)';
    const status = mapStatusBucket(ticketRaw['status']);
    const priority = mapPriority(ticketRaw['priority']);
    const requester = mapParty(ticketRaw['requesterUid']);
    const assignee = mapAssignee(ticketRaw['assignedAppUserId']);
    const description = extractDescription(logsRaw);
    const activities = mapActivities(logsRaw);
    const raw = stripCanonicalKeys(ticketRaw);
    const clientId = pickNumber(ticketRaw, [
      'clientId',
      'clientID',
      'organizationId',
      'orgId',
    ]);

    return {
      id: cleanId,
      provider: 'ninjaone',
      displayId: `T-${cleanId}`,
      subject,
      status,
      statusLabel: extractStatusLabel(ticketRaw['status']),
      priority,
      boardName: typeof raw['boardName'] === 'string' ? (raw['boardName'] as string) : null,
      typeLabel: typeof ticketRaw['type'] === 'string' ? (ticketRaw['type'] as string) : null,
      requester,
      assignee,
      createdAt: epochSecondsToIso(numberOf(ticketRaw['createTime']) ?? 0),
      updatedAt: epochSecondsToIso(numberOf(ticketRaw['lastUpdated']) ?? 0),
      description,
      activities,
      attachments: [],
      raw,
      companyId: null,
      companyName: null,
      externalClientId: clientId !== null ? String(clientId) : null,
    };
  }

  private async fetchTicketBoards(
    ctx: IntegrationContext,
    headers: Record<string, string>,
    baseUrl: string,
  ): Promise<Array<{ id: number; name: string }>> {
    const url = `${baseUrl.replace(/\/$/, '')}/v2/ticketing/trigger/boards`;
    const res = await fetchWithRetry(url, {
      method: 'GET',
      headers,
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: 'NinjaOne',
    });
    if (res.status === 401 || res.status === 403) {
      this.invalidateToken(ctx);
      throw new DriverAuthError(
        `NinjaOne ticketing boards failed (${res.status}). Token rejected.`,
      );
    }
    if (res.status === 404) {
      // No ticketing add-on for this tenant — surface as a clean
      // "not enabled" path. The controller maps this to a 400 with a
      // helpful message rather than a generic 5xx.
      return [];
    }
    if (!res.ok) {
      throw new Error(`NinjaOne ticketing boards returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(json)) return [];
    const boards: Array<{ id: number; name: string }> = [];
    for (const b of json) {
      const id = numberOf(b['id']);
      const name = typeof b['name'] === 'string' ? (b['name'] as string) : '';
      if (id !== null) boards.push({ id, name });
    }
    return boards;
  }

}

function parseConfig(raw: Record<string, unknown>): { baseUrl: string } {
  return ninjaoneConfigSchema.parse(raw ?? {});
}

function assertExpectedResourceKey(resourceKey: string): void {
  if (NINJAONE_RESOURCE_KEYS.has(resourceKey)) return;
  const known = [...NINJAONE_RESOURCE_KEYS].map((k) => `"${k}"`).join(', ');
  throw new Error(
    `NinjaOne driver received unexpected resourceKey "${resourceKey}". ` +
      `This driver advertises ${known}; the only way to reach this code ` +
      `is via a stale IntegrationResource row left behind by an earlier ` +
      `driver iteration. Disable or remove that row to stop duplicate-` +
      `asset creation on every sync.`,
  );
}

/**
 * Returns the subset of devices that belong on the resource the
 * runner is currently syncing.
 *
 *   - `records` (agent devices)         → keep `deviceType === 'AgentDevice'`
 *   - `nms`     (non-agent / NMS / VMs) → keep everything else
 *
 * Devices with no `deviceType` at all (NinjaOne occasionally omits
 * the field on partially-onboarded rows) are treated as non-agent —
 * `records` drops them, `nms` keeps them — so we never silently lose
 * a managed endpoint to a missing-field bug, and operators see the
 * stragglers in the NMS bucket where they can investigate.
 */
function filterByResource<T extends NinjaOneDevice>(
  resourceKey: string,
  devices: T[],
): T[] {
  if (resourceKey === NINJAONE_AGENT_RESOURCE_KEY) {
    return devices.filter((d) => d.deviceType === NINJAONE_AGENT_DEVICE_TYPE);
  }
  if (resourceKey === NINJAONE_NMS_RESOURCE_KEY) {
    return devices.filter((d) => d.deviceType !== NINJAONE_AGENT_DEVICE_TYPE);
  }
  return devices;
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
      // Multi-line summary covering EVERY volume on the device, one
      // line each. Map this onto a TEXTAREA / rich-text AssetField
      // when the asset layout has a single "Storage" or "Volumes"
      // multi-line slot.
      const summary = formatVolumesSummary(volumes);
      if (summary !== null) out.volumesSummary = summary;
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

  // Derive human-readable formatted variants of the byte + Hz fields
  // so they project cleanly onto TEXT / rich-text AssetFields. The
  // raw numeric values remain available for anyone wiring them into
  // NUMBER fields or analytics.
  for (const [src, dst] of [
    ['memoryCapacity', 'memoryCapacityHuman'],
    ['systemTotalPhysicalMemory', 'systemTotalPhysicalMemoryHuman'],
    ['firstVolumeCapacity', 'firstVolumeCapacityHuman'],
    ['firstVolumeFreeSpace', 'firstVolumeFreeSpaceHuman'],
  ] as const) {
    const v = out[src];
    if (typeof v === 'number') out[dst] = formatBytes(v);
  }
  for (const [src, dst] of [
    ['processorClockSpeed', 'processorClockSpeedHuman'],
    ['processorMaxClockSpeed', 'processorMaxClockSpeedHuman'],
  ] as const) {
    const v = out[src];
    if (typeof v === 'number') out[dst] = formatHertz(v);
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

/**
 * Format a byte count for display next to its raw numeric variant
 * (so users mapping onto a TEXT / rich-text field see something
 * readable). Uses a 1024 divisor with conventional `GB` / `TB`
 * suffixes — matches how Windows and macOS surface storage / RAM
 * sizes in their UIs, even though the suffix technically refers to
 * the SI value. Operators wanting the exact byte count still have
 * the raw `*Capacity` / `*FreeSpace` numeric field.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

/**
 * Format a Hz count as a human-readable clock speed. Uses SI divisors
 * (1000) since clock speeds are conventionally reported that way —
 * a "2.1 GHz" CPU is exactly 2,100,000,000 Hz, not 2 * 2^30.
 */
function formatHertz(hz: number): string {
  if (!Number.isFinite(hz) || hz < 0) return String(hz);
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(2)} GHz`;
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(0)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(0)} kHz`;
  return `${hz} Hz`;
}

/**
 * Build a multi-line, human-readable summary of every volume on the
 * device — one line per volume — for mapping onto a TEXTAREA / rich-
 * text AssetField. Each line:
 *
 *   `<name>[ <label>] — <capacity> total, <freeSpace> free (<fs>)`
 *
 * Pieces are dropped silently when missing so partial volume records
 * don't render as `"undefined"`. Returns `null` when the array is
 * empty / no usable lines are produced (so the caller can leave the
 * `volumesSummary` field unset rather than emitting an empty string).
 */
function formatVolumesSummary(volumes: unknown): string | null {
  if (!Array.isArray(volumes) || volumes.length === 0) return null;
  const lines: string[] = [];
  for (const v of volumes) {
    if (!v || typeof v !== 'object') continue;
    const vol = v as Record<string, unknown>;
    const name = typeof vol.name === 'string' ? vol.name.trim() : '';
    const labelRaw = typeof vol.label === 'string' ? vol.label.trim() : '';
    const fs = typeof vol.fileSystem === 'string' ? vol.fileSystem.trim() : '';
    const cap =
      typeof vol.capacity === 'number' ? formatBytes(vol.capacity) : null;
    const free =
      typeof vol.freeSpace === 'number' ? formatBytes(vol.freeSpace) : null;

    const lhs = labelRaw ? `${name} ${labelRaw}`.trim() : name;
    if (!lhs && !cap && !free && !fs) continue;

    let sizes = '';
    if (cap && free) sizes = `${cap} total, ${free} free`;
    else if (cap) sizes = `${cap} total`;
    else if (free) sizes = `${free} free`;

    const fsTag = fs ? `(${fs})` : '';

    const parts: string[] = [];
    if (lhs) parts.push(lhs);
    if (sizes) parts.push(`— ${sizes}`);
    if (fsTag) parts.push(fsTag);

    const line = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines.length ? lines.join('\n') : null;
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

// ---------------------------------------------------------------------
// Ticketing — helpers
// ---------------------------------------------------------------------

/**
 * Keys lifted onto the canonical TicketDetailDto. Stripped from the
 * `raw` bag so the "Provider details" panel doesn't duplicate them.
 */
const TICKET_CANONICAL_KEYS = new Set([
  'id',
  'subject',
  'status',
  'priority',
  'type',
  'createTime',
  'lastUpdated',
  'requesterUid',
  'assignedAppUserId',
  'boardName',
]);

function stripCanonicalKeys(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (TICKET_CANONICAL_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function numberOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseClientId(externalOrgId: string | null): number | null {
  if (externalOrgId === null) return null;
  const parsed = Number.parseInt(externalOrgId, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapStatusBucket(raw: unknown): TicketStatusBucket {
  if (!raw || typeof raw !== 'object') return 'open';
  const parentId = numberOf((raw as Record<string, unknown>)['parentId']);
  const statusId = numberOf((raw as Record<string, unknown>)['statusId']);
  const id = parentId ?? statusId;
  if (id === 5) return 'closed';
  if (id === 4) return 'resolved';
  if (id === 3) return 'pending';
  return 'open';
}

function extractStatusLabel(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const dn = (raw as Record<string, unknown>)['displayName'];
  if (typeof dn === 'string' && dn.length > 0) return dn;
  const name = (raw as Record<string, unknown>)['name'];
  if (typeof name === 'string' && name.length > 0) return name;
  return null;
}

function mapPriority(raw: unknown): TicketPriority {
  if (typeof raw !== 'string') return 'none';
  switch (raw.toUpperCase()) {
    case 'LOW':
      return 'low';
    case 'MEDIUM':
    case 'NORMAL':
      return 'normal';
    case 'HIGH':
      return 'high';
    case 'CRITICAL':
    case 'URGENT':
      return 'urgent';
    default:
      return 'none';
  }
}

function mapParty(uid: unknown): { id: string | null; name: string | null } | null {
  if (typeof uid !== 'string' || !uid) return null;
  return { id: uid, name: null };
}

function mapAssignee(
  appUserId: unknown,
): { id: string | null; name: string | null } | null {
  const n = numberOf(appUserId);
  if (n === null) return null;
  return { id: String(n), name: null };
}

/**
 * Pulls a value from `row` by trying each candidate key in order.
 * NinjaOne's `/trigger/board/{id}/run` response shape varies with
 * the board's "displayed fields" configuration — fields not enabled
 * on the board view are omitted entirely. We try the canonical key
 * first, then a few common aliases so we don't render "(no subject)"
 * just because a board uses `summary` instead of `subject`.
 */
function pickString(
  row: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickNumber(
  row: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const v = numberOf(row[k]);
    if (v !== null) return v;
  }
  return null;
}

function mapNinjaTicketListRow(
  row: Record<string, unknown>,
  board: { id: number; name: string },
): TicketListDto | null {
  const id = pickNumber(row, ['id', 'ticketId', 'ticketID']);
  if (id === null) return null;
  const subject =
    pickString(row, ['subject', 'summary', 'name', 'title']) ?? '(no subject)';
  const clientId = pickNumber(row, [
    'clientId',
    'clientID',
    'organizationId',
    'orgId',
  ]);
  return {
    id: String(id),
    provider: 'ninjaone',
    displayId: `T-${id}`,
    subject,
    status: mapStatusBucket(row['status']),
    statusLabel: extractStatusLabel(row['status']),
    priority: mapPriority(row['priority']),
    boardName: board.name || null,
    typeLabel: pickString(row, ['type', 'ticketType']),
    requester: mapParty(row['requesterUid'] ?? row['requestorUid']),
    assignee: mapAssignee(
      row['assignedAppUserId'] ?? row['assignedAppUserID'],
    ),
    createdAt: epochSecondsToIso(
      pickNumber(row, ['createTime', 'created', 'createdAt']) ?? 0,
    ),
    updatedAt: epochSecondsToIso(
      pickNumber(row, ['lastUpdated', 'updated', 'updatedAt']) ?? 0,
    ),
    // The service layer resolves these from the upstream clientId
    // when stitching the response. Drivers only know upstream tenants,
    // not Weavestream companies.
    companyId: null,
    companyName: null,
    externalClientId: clientId !== null ? String(clientId) : null,
  };
}

/**
 * NinjaOne keeps the original ticket description as the FIRST log
 * entry with type `DESCRIPTION`. Subsequent comments / system events
 * append to the same log. We surface the description separately so
 * the UI's header block has the body without duplicating it in the
 * activity timeline.
 */
function extractDescription(
  logs: Array<Record<string, unknown>>,
): string | null {
  if (!Array.isArray(logs) || logs.length === 0) return null;
  for (const entry of logs) {
    const type = typeof entry['type'] === 'string' ? entry['type'] : '';
    if (type !== 'DESCRIPTION') continue;
    const body = entry['body'];
    if (typeof body === 'string' && body.trim().length > 0) return body;
    const html = entry['htmlBody'];
    if (typeof html === 'string' && html.trim().length > 0) {
      return htmlToPlain(html);
    }
  }
  return null;
}

function mapActivities(
  logs: Array<Record<string, unknown>>,
): TicketActivityDto[] {
  if (!Array.isArray(logs)) return [];
  const out: TicketActivityDto[] = [];
  for (const entry of logs) {
    const id = numberOf(entry['id']);
    if (id === null) continue;
    const rawKind =
      typeof entry['type'] === 'string' ? (entry['type'] as string) : 'OTHER';
    // Skip the description — it's surfaced via the header block.
    if (rawKind === 'DESCRIPTION') continue;
    const kind = mapActivityKind(rawKind, entry);
    const body =
      typeof entry['body'] === 'string' && (entry['body'] as string).trim().length > 0
        ? (entry['body'] as string)
        : typeof entry['htmlBody'] === 'string' &&
            (entry['htmlBody'] as string).trim().length > 0
          ? htmlToPlain(entry['htmlBody'] as string)
          : null;
    const occurredAt =
      epochSecondsToIso(numberOf(entry['createTime']) ?? 0) ??
      new Date().toISOString();
    const authorUid =
      typeof entry['appUserContactUid'] === 'string'
        ? (entry['appUserContactUid'] as string)
        : null;
    out.push({
      id: String(id),
      kind,
      label: humanizeActivityKind(kind, rawKind),
      body,
      author: authorUid ? { id: authorUid, name: null } : null,
      occurredAt,
      rawKind,
    });
  }
  // Sort oldest first — `createTime` may not always come back in order.
  out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return out;
}

function mapActivityKind(
  rawKind: string,
  entry: Record<string, unknown>,
): TicketActivityKind {
  const isPublic = entry['publicEntry'] === true;
  const isSystem = entry['system'] === true;
  switch (rawKind) {
    case 'COMMENT':
      return isPublic ? 'comment' : 'internal_note';
    case 'CONDITION':
    case 'INFO':
      return 'status_change';
    case 'SAVE':
      return isSystem ? 'system' : 'status_change';
    case 'DELETE':
      return 'system';
    default:
      return 'other';
  }
}

function humanizeActivityKind(
  kind: TicketActivityKind,
  rawKind: string,
): string {
  switch (kind) {
    case 'comment':
      return 'Comment';
    case 'internal_note':
      return 'Internal note';
    case 'status_change':
      return 'Status change';
    case 'assignment':
      return 'Assignment change';
    case 'system':
      return 'System event';
    default:
      return rawKind ? rawKind.charAt(0) + rawKind.slice(1).toLowerCase() : 'Event';
  }
}

/**
 * Minimal HTML → plain conversion for ticket bodies. NinjaOne's
 * `htmlBody` is operator-authored HTML; we only ever surface it
 * inside our own UI (which renders it as markdown) and as LLM
 * context, so stripping to text is safe. We never inject it as HTML
 * into the page.
 */
function htmlToPlain(html: string): string {
  let stripped = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n');

  // Loop until no more tag-like sequences remain. A single pass of
  // `/<[^>]+>/g` is vulnerable to nested patterns like `<scr<script>ipt>`
  // collapsing back into `<script>` after one substitution, so we keep
  // stripping until the string is stable.
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]*>?/g, '');
  } while (stripped !== prev);

  return stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  { key: 'systemTotalPhysicalMemoryHuman', label: 'Total physical memory', hintType: 'TEXT', alwaysPresent: false },

  // Memory (flattened from `memory`)
  { key: 'memoryCapacity', label: 'Memory capacity (bytes)', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'memoryCapacityHuman', label: 'Memory capacity', hintType: 'TEXT', alwaysPresent: false },

  // First processor (flattened from `processors[0]`)
  { key: 'processorName', label: 'Processor', hintType: 'TEXT', alwaysPresent: false },
  { key: 'processorArchitecture', label: 'Processor architecture', hintType: 'TEXT', alwaysPresent: false },
  { key: 'processorNumCores', label: 'Processor cores', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'processorNumLogicalCores', label: 'Processor logical cores', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'processorClockSpeed', label: 'Processor clock speed (Hz)', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'processorClockSpeedHuman', label: 'Processor clock speed', hintType: 'TEXT', alwaysPresent: false },
  { key: 'processorMaxClockSpeed', label: 'Processor max clock speed (Hz)', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'processorMaxClockSpeedHuman', label: 'Processor max clock speed', hintType: 'TEXT', alwaysPresent: false },

  // Volumes — full per-volume detail isn't projectable onto primitive
  // AssetFields, so surface the count + the first volume's headline
  // attributes + a multi-line text summary covering every volume.
  // Operators wanting per-volume reporting can hit the NinjaOne
  // /v2/queries/volumes endpoint directly.
  { key: 'volumeCount', label: 'Volume count', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'volumesSummary', label: 'Volumes summary', hintType: 'TEXTAREA', alwaysPresent: false },
  { key: 'firstVolumeName', label: 'First volume name', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeLabel', label: 'First volume label', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeFileSystem', label: 'First volume filesystem', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeDeviceType', label: 'First volume device type', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeSerialNumber', label: 'First volume serial number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeCapacity', label: 'First volume capacity (bytes)', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'firstVolumeCapacityHuman', label: 'First volume capacity', hintType: 'TEXT', alwaysPresent: false },
  { key: 'firstVolumeFreeSpace', label: 'First volume free space (bytes)', hintType: 'NUMBER', alwaysPresent: false },
  { key: 'firstVolumeFreeSpaceHuman', label: 'First volume free space', hintType: 'TEXT', alwaysPresent: false },

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
