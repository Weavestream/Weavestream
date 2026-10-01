import {
  DriverAuthError,
  DriverRateLimitError,
} from '../integration-driver.js';
import { fetchWithRetry } from '../driver-utils.js';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareHttp {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly backoffMs: number;
}

export interface CloudflareCallContext {
  apiToken: string;
  http: CloudflareHttp;
  correlationId: string;
}

/**
 * Cloudflare Zero Trust Gateway list metadata.
 *
 * `type` values per the Gateway API: `IP`, `SERIAL`, `URL`, `DOMAIN`,
 * `EMAIL`. We only manage `IP` lists; the others surface in the
 * register dialog with their type tag and a "not supported" note so
 * the operator understands why they can't be picked.
 */
export interface CloudflareList {
  externalListId: string;
  name: string;
  description: string | null;
  numItems: number;
  /** Lowercased: 'ip' | 'serial' | 'url' | 'domain' | 'email' | unknown. */
  kind: string;
}

export interface CloudflareListItem {
  /** Canonical IP / CIDR value. Gateway items have no per-item id. */
  ip: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: {
    page?: number;
    total_pages?: number;
    cursors?: {
      before?: string | null;
      after?: string | null;
    };
  };
}

interface CloudflareGatewayListRaw {
  id?: string;
  name?: string;
  description?: string | null;
  type?: string;
  count?: number;
}

interface CloudflareGatewayItemRaw {
  value?: string;
}

/**
 * Cloudflare Zero Trust Gateway Lists client.
 *
 * Scope: IP-typed gateway lists only — the lists Cloudflare Tunnel
 * access policies and Zero Trust Gateway rules can reference. The
 * Rules Lists API (`/rules/lists`) is a different feature and is NOT
 * what tunnel policies consume.
 *
 * Auth: Bearer API token. 401/403 → `DriverAuthError` so the
 * orchestrator can pause the integration. 429 → `DriverRateLimitError`.
 *
 * Update model: Gateway lists do NOT use the async bulk-operations
 * pattern. `PATCH /gateway/lists/{id}` accepts `{ append, remove }`
 * arrays and applies them synchronously, returning the updated list.
 * Items are addressed by their string value — there's no per-item id.
 */

/**
 * Registrar view of one domain, normalised. Every field is nullable because
 * Cloudflare returns a mostly-null record for names it knows about but does
 * not register (a zone whose registration lives at another registrar, or a
 * domain that has moved to a different Cloudflare account).
 */
export interface CloudflareRegistrarDomain {
  name: string;
  /** True only when Cloudflare is the registrar of record on this account. */
  cloudflareRegistration: boolean;
  registrar: string | null;
  autoRenew: boolean | null;
  locked: boolean | null;
  registeredAt: Date | null;
  expiresAt: Date | null;
  registryStatuses: string[];
  nameservers: string[];
  /** Whether a DNS zone for this name exists on the account. */
  hasZone: boolean;
}

interface CloudflareZoneRaw {
  name?: string;
  status?: string;
  name_servers?: string[];
}

interface CloudflareRegistrarRaw {
  name?: string;
  cloudflare_registration?: boolean | null;
  current_registrar?: string | null;
  auto_renew?: boolean | null;
  locked?: boolean | null;
  registered_at?: string | null;
  expires_at?: string | null;
  registry_statuses?: string | string[] | null;
  name_servers?: string[] | null;
}

/** Shown on a 401/403 from any registrar call, so the fix named is the right one. */
const REGISTRAR_AUTH_HINT =
  'Registrar sync needs the API token to carry Account » Registrar: Domains » Read and Zone » Zone » Read, in addition to the Zero Trust permission the IP-list feature uses.';

/** Pagination ceiling (50/page → 10,000 domains); hitting it is an error, not a truncation. */
const MAX_PAGES = 200;

/** Zone states that still represent a domain the account controls. */
const LIVE_ZONE_STATUSES = new Set(['active', 'pending', 'initializing']);

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toStatusList(v: string | string[] | null | undefined): string[] {
  if (!v) return [];
  const raw = Array.isArray(v) ? v : v.split(',');
  return raw.map((x) => x.trim()).filter((x) => x.length > 0);
}

export class CloudflareApiClient {
  /** Verifies the token + account by listing gateway lists with no side effects. */
  async testConnection(
    accountId: string,
    ctx: CloudflareCallContext,
  ): Promise<void> {
    await this.listAllLists(accountId, ctx);
  }

  /**
   * List every Zero Trust Gateway list on the account, regardless of
   * type. Filtering to `kind=ip` happens at the surface layer so the
   * operator can see non-IP lists in the register dialog (and
   * understand why they aren't available).
   */
  async listAllLists(
    accountId: string,
    ctx: CloudflareCallContext,
  ): Promise<CloudflareList[]> {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/gateway/lists`;
    const body = await this.callJson<CloudflareGatewayListRaw[]>('GET', url, ctx);
    return (body ?? [])
      .map((l) => ({
        externalListId: l.id ?? '',
        name: l.name ?? '',
        description: l.description ?? null,
        numItems: typeof l.count === 'number' ? l.count : 0,
        kind: (l.type ?? '').toLowerCase(),
      }))
      .filter((l) => l.externalListId.length > 0);
  }

  async listListItems(
    accountId: string,
    listId: string,
    ctx: CloudflareCallContext,
  ): Promise<CloudflareListItem[]> {
    const out: CloudflareListItem[] = [];
    let page = 1;
    while (true) {
      const url = new URL(
        `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/gateway/lists/${encodeURIComponent(listId)}/items`,
      );
      url.searchParams.set('per_page', '1000');
      url.searchParams.set('page', String(page));
      const body = await this.callJson<CloudflareGatewayItemRaw[]>(
        'GET',
        url.toString(),
        ctx,
      );
      const items = body ?? [];
      for (const item of items) {
        if (typeof item.value === 'string' && item.value.length > 0) {
          out.push({ ip: item.value });
        }
      }
      if (items.length < 1000) break;
      page += 1;
      if (page > 50) break; // hard cap defensively
    }
    return out;
  }

  /**
   * Synchronously bring Cloudflare's view of a Gateway list to the
   * desired set of values. Computes the diff against the items the
   * caller supplies as the current Cloudflare state and PATCHes the
   * append + remove arrays. Returns the post-update items so the
   * caller can store the canonicalised value Cloudflare echoed back.
   *
   * Empty diffs short-circuit without an HTTP call so a no-op
   * "Overwrite Cloudflare" doesn't burn rate limit.
   */
  async syncListItems(
    accountId: string,
    listId: string,
    desired: ReadonlyArray<{ ip: string }>,
    cfCurrent: ReadonlyArray<CloudflareListItem>,
    ctx: CloudflareCallContext,
  ): Promise<{ items: CloudflareListItem[] }> {
    const desiredValues = new Set(desired.map((e) => e.ip));
    const currentValues = new Set(cfCurrent.map((e) => e.ip));
    const append: Array<{ value: string }> = [];
    for (const v of desiredValues) {
      if (!currentValues.has(v)) append.push({ value: v });
    }
    const remove: string[] = [];
    for (const v of currentValues) {
      if (!desiredValues.has(v)) remove.push(v);
    }
    if (append.length === 0 && remove.length === 0) {
      return { items: [...cfCurrent] };
    }

    const url = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/gateway/lists/${encodeURIComponent(listId)}`;
    await this.callJson<unknown>('PATCH', url, ctx, JSON.stringify({ append, remove }));

    const items = await this.listListItems(accountId, listId, ctx);
    return { items };
  }

  // -------------------------------------------------------------------
  // Internal HTTP helpers
  // -------------------------------------------------------------------


  // -------------------------------------------------------------------
  // Registrar
  // -------------------------------------------------------------------

  /**
   * Every domain name the account plausibly owns, from two sources.
   *
   * The zone list is reliable and fully paginated. The registrar list is
   * treated as a *hint only*: on real accounts it has been observed to report
   * a `total_count` well above the rows it actually returns, with later pages
   * coming back empty, so relying on it alone silently drops domains. The two
   * are unioned and each name is then fetched individually by
   * {@link getRegistrarDomain}, which is authoritative.
   */
  async listRegistrarCandidates(
    accountId: string,
    ctx: CloudflareCallContext,
  ): Promise<Map<string, { hasZone: boolean; zoneNameservers: string[] }>> {
    const out = new Map<string, { hasZone: boolean; zoneNameservers: string[] }>();

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(`${CLOUDFLARE_API_BASE}/zones`);
      url.searchParams.set('account.id', accountId);
      url.searchParams.set('per_page', '50');
      url.searchParams.set('page', String(page));
      const env = await this.callJsonEnvelope<CloudflareZoneRaw[]>(
        'GET', url.toString(), ctx, undefined, REGISTRAR_AUTH_HINT,
      );
      const zones = env.result ?? [];
      for (const z of zones) {
        const name = (z.name ?? '').toLowerCase();
        if (!name || !LIVE_ZONE_STATUSES.has((z.status ?? '').toLowerCase())) continue;
        out.set(name, { hasZone: true, zoneNameservers: z.name_servers ?? [] });
      }
      const totalPages = env.result_info?.total_pages ?? 1;
      if (zones.length === 0 || page >= totalPages) break;
      if (page === MAX_PAGES) throw new Error(`Cloudflare zone list exceeded ${MAX_PAGES} pages`);
    }

    // Registrar list: paginate until an empty page rather than trusting
    // total_pages, and union in anything the zone list did not have.
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(
        `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/registrar/domains`,
      );
      url.searchParams.set('per_page', '50');
      url.searchParams.set('page', String(page));
      const env = await this.callJsonEnvelope<CloudflareRegistrarRaw[]>(
        'GET', url.toString(), ctx, undefined, REGISTRAR_AUTH_HINT,
      );
      const rows = env.result ?? [];
      if (rows.length === 0) break;
      for (const r of rows) {
        const name = (r.name ?? '').toLowerCase();
        if (name && !out.has(name)) out.set(name, { hasZone: false, zoneNameservers: [] });
      }
      // A partial list would stamp the unlisted remainder as missing.
      if (page === MAX_PAGES) throw new Error(`Cloudflare registrar list exceeded ${MAX_PAGES} pages`);
    }
    return out;
  }

  /**
   * Authoritative registrar record for one name, or null when Cloudflare has
   * nothing useful (no record, or a record with no registrar and no expiry —
   * the shape returned for a domain that has moved to another account).
   */
  async getRegistrarDomain(
    accountId: string,
    name: string,
    hint: { hasZone: boolean; zoneNameservers: string[] },
    ctx: CloudflareCallContext,
  ): Promise<CloudflareRegistrarDomain | null> {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/registrar/domains/${encodeURIComponent(name)}`;
    let raw: CloudflareRegistrarRaw | null;
    try {
      raw = await this.callJson<CloudflareRegistrarRaw>(
        'GET', url, ctx, undefined, REGISTRAR_AUTH_HINT,
      );
    } catch (e) {
      // Only a Cloudflare 4xx ("no registrar record for this name") counts as
      // absent. Auth, rate-limit, 5xx and network failures abort the whole
      // sync: treating them as absent would stamp live domains as missing.
      const status = (e as { status?: number }).status;
      const notFound =
        !(e instanceof DriverAuthError || e instanceof DriverRateLimitError) &&
        status !== undefined &&
        status >= 400 &&
        status < 500;
      if (!notFound) throw e;
      raw = null;
    }

    const expiresAt = parseDate(raw?.expires_at);
    const registrar = raw?.current_registrar ?? null;
    if (!hint.hasZone && !registrar && !expiresAt) return null;

    const nameservers = (raw?.name_servers?.length ? raw.name_servers : hint.zoneNameservers)
      .map((n) => n.toLowerCase());

    return {
      name,
      cloudflareRegistration: raw?.cloudflare_registration === true,
      registrar,
      autoRenew: typeof raw?.auto_renew === 'boolean' ? raw.auto_renew : null,
      locked: typeof raw?.locked === 'boolean' ? raw.locked : null,
      registeredAt: parseDate(raw?.registered_at),
      expiresAt,
      registryStatuses: toStatusList(raw?.registry_statuses),
      nameservers,
      hasZone: hint.hasZone,
    };
  }

  private async callJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    ctx: CloudflareCallContext,
    body?: string,
    authHint?: string,
  ): Promise<T | null> {
    const env = await this.callJsonEnvelope<T>(method, url, ctx, body, authHint);
    return env.result ?? null;
  }

  private async callJsonEnvelope<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    ctx: CloudflareCallContext,
    body?: string,
    authHint?: string,
  ): Promise<CloudflareEnvelope<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.apiToken}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetchWithRetry(url, {
      method,
      headers,
      body,
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: 'Cloudflare',
    });

    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        authHint
          ? `Cloudflare ${method} ${url} returned ${res.status}. ${authHint}`
          : `Cloudflare ${method} ${url} returned ${res.status}. The API token must have Account » Zero Trust » Edit (Gateway Lists live under Zero Trust — "Account Filter Lists" is the WAF Rules Lists API and will not work for Tunnel access policies). Verify the account id is correct as well.`,
      );
    }
    if (res.status === 429) {
      throw new DriverRateLimitError(
        `Cloudflare ${method} ${url} rate limited.`,
      );
    }

    let payload: CloudflareEnvelope<T> | null = null;
    try {
      payload = (await res.json()) as CloudflareEnvelope<T>;
    } catch {
      payload = null;
    }
    if (!res.ok || !payload || payload.success === false) {
      const detail =
        payload?.errors
          ?.map((e) => e.message ?? `code ${e.code}`)
          .filter(Boolean)
          .join('; ') ?? `HTTP ${res.status}`;
      // `status` lets callers tell "no such record" (4xx) from a transient
      // failure (5xx); the message stays as before for every other caller.
      throw Object.assign(new Error(`Cloudflare ${method} ${url} failed: ${detail}`), {
        status: res.status,
      });
    }
    return payload;
  }
}
