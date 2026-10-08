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
    total_count?: number;
    /** Registrar registrations: opaque next-page token, '' on the last page. */
    cursor?: string | null;
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
 * Registrar view of one domain, normalised. The registrar fields are null for
 * a zone whose registration lives at another registrar: the registrations API
 * only knows domains that Cloudflare Registrar holds on this account.
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
  /** Cloudflare's registration status (`active`, `expired`, `redemption_period`, …). */
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

/** `GET /accounts/{id}/registrar/registrations` row. Only the fields read here. */
interface CloudflareRegistrationRaw {
  domain_name?: string;
  status?: string | null;
  created_at?: string | null;
  expires_at?: string | null;
  auto_renew?: boolean | null;
  locked?: boolean | null;
}

/** Shown on a 401/403 from any registrar call, so the fix named is the right one. */
const REGISTRAR_AUTH_HINT =
  'Registrar sync needs the API token to carry Zone » Zone » Read for every zone on the account and read access to Registrar for this account, in addition to the Zero Trust permission the IP-list feature uses. Check also that the token\'s account resources include this account.';

/** Pagination ceiling (50/page → 10,000 domains); hitting it is an error, not a truncation. */
const MAX_PAGES = 200;

/** Zone states that still represent a domain the account controls. */
const LIVE_ZONE_STATUSES = new Set(['active', 'pending', 'initializing']);

/**
 * A failure Cloudflare reported, or a malformed Cloudflare answer. The
 * message names the request and Cloudflare's own error text, never the
 * token, so it is fit to show to the operator who configured the
 * integration (the registrar sync stores it on its run row).
 */
export class CloudflareApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
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
  // Registrar
  // -------------------------------------------------------------------

  /**
   * Every domain on the account: its live DNS zones unioned with its
   * Cloudflare Registrar registrations. Both lists are read in full before
   * anything is returned, and any failure (auth, rate limit, 4xx, 5xx, a
   * malformed page) throws. A partial answer would erase registrar facts or
   * stamp live domains as missing, so there is none.
   */
  async listRegistrarDomains(
    accountId: string,
    ctx: CloudflareCallContext,
  ): Promise<CloudflareRegistrarDomain[]> {
    const zones = await this.listZones(accountId, ctx);
    const registrations = await this.listRegistrations(accountId, ctx);
    const names = new Set([...zones.keys(), ...registrations.keys()]);
    return [...names].map((name) => {
      const zone = zones.get(name);
      const reg = registrations.get(name);
      return {
        name,
        cloudflareRegistration: reg !== undefined,
        registrar: reg ? 'Cloudflare' : null,
        autoRenew: typeof reg?.auto_renew === 'boolean' ? reg.auto_renew : null,
        locked: typeof reg?.locked === 'boolean' ? reg.locked : null,
        registeredAt: parseDate(reg?.created_at),
        expiresAt: parseDate(reg?.expires_at),
        registryStatuses: reg?.status ? [reg.status] : [],
        nameservers: (zone ?? []).map((n) => n.toLowerCase()),
        hasZone: zone !== undefined,
      };
    });
  }

  /**
   * Cheap permission probe for "Test connection": one page of each list the
   * registrar sync reads, so a token missing either scope fails here rather
   * than on the next sweep.
   */
  async checkRegistrarAccess(
    accountId: string,
    ctx: CloudflareCallContext,
  ): Promise<{ zones: number; registrations: number }> {
    const zones = await this.fetchZonePage(accountId, 1, 5, ctx);
    const regs = await this.fetchRegistrationPage(accountId, '', 1, ctx);
    return {
      zones: zones.result_info?.total_count ?? (zones.result ?? []).length,
      registrations: (regs.result ?? []).length,
    };
  }

  /** Live zones by lowercased name → assigned nameservers. */
  private async listZones(
    accountId: string,
    ctx: CloudflareCallContext,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const env = await this.fetchZonePage(accountId, page, 50, ctx);
      const zones = env.result ?? [];
      for (const z of zones) {
        const name = (z.name ?? '').toLowerCase();
        if (!name || !LIVE_ZONE_STATUSES.has((z.status ?? '').toLowerCase())) continue;
        out.set(name, z.name_servers ?? []);
      }
      const totalPages = env.result_info?.total_pages ?? 1;
      if (zones.length === 0 || page >= totalPages) return out;
    }
    throw new CloudflareApiError(`Cloudflare zone list exceeded ${MAX_PAGES} pages`);
  }

  /**
   * Registrar registrations by lowercased name. Cursor-paginated: an empty
   * `result_info.cursor` marks the last page. A cursor that repeats would
   * loop forever, so it is an error, as is running past MAX_PAGES.
   */
  private async listRegistrations(
    accountId: string,
    ctx: CloudflareCallContext,
  ): Promise<Map<string, CloudflareRegistrationRaw>> {
    const out = new Map<string, CloudflareRegistrationRaw>();
    const seen = new Set<string>();
    let cursor = '';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const env = await this.fetchRegistrationPage(accountId, cursor, 50, ctx);
      if (!Array.isArray(env.result)) {
        throw new CloudflareApiError('Cloudflare registrations list returned no result array');
      }
      for (const r of env.result) {
        const name = (r.domain_name ?? '').toLowerCase();
        if (name) out.set(name, r);
      }
      const next = env.result_info?.cursor ?? '';
      if (!next) return out;
      if (seen.has(next)) throw new CloudflareApiError('Cloudflare registrations list repeated a page cursor');
      seen.add(next);
      cursor = next;
    }
    throw new CloudflareApiError(`Cloudflare registrations list exceeded ${MAX_PAGES} pages`);
  }

  private fetchZonePage(
    accountId: string,
    page: number,
    perPage: number,
    ctx: CloudflareCallContext,
  ): Promise<CloudflareEnvelope<CloudflareZoneRaw[]>> {
    const url = new URL(`${CLOUDFLARE_API_BASE}/zones`);
    url.searchParams.set('account.id', accountId);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    return this.callJsonEnvelope<CloudflareZoneRaw[]>(
      'GET', url.toString(), ctx, undefined, REGISTRAR_AUTH_HINT,
    );
  }

  private fetchRegistrationPage(
    accountId: string,
    cursor: string,
    perPage: number,
    ctx: CloudflareCallContext,
  ): Promise<CloudflareEnvelope<CloudflareRegistrationRaw[]>> {
    const url = new URL(
      `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/registrar/registrations`,
    );
    url.searchParams.set('per_page', String(perPage));
    if (cursor) url.searchParams.set('cursor', cursor);
    return this.callJsonEnvelope<CloudflareRegistrationRaw[]>(
      'GET', url.toString(), ctx, undefined, REGISTRAR_AUTH_HINT,
    );
  }

  // -------------------------------------------------------------------
  // Internal HTTP helpers
  // -------------------------------------------------------------------

  private async callJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    ctx: CloudflareCallContext,
    body?: string,
  ): Promise<T | null> {
    const env = await this.callJsonEnvelope<T>(method, url, ctx, body);
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

    let payload: CloudflareEnvelope<T> | null = null;
    try {
      payload = (await res.json()) as CloudflareEnvelope<T>;
    } catch {
      payload = null;
    }
    // Cloudflare's own error text ("Authentication error", "Unauthorized to
    // access requested resource", code 10000, …) names the real cause; it
    // never carries the token, so it goes into the message verbatim.
    const detail =
      payload?.errors
        ?.map((e) => (e.code ? `${e.message ?? 'error'} (code ${e.code})` : e.message))
        .filter(Boolean)
        .join('; ') || `HTTP ${res.status}`;

    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        authHint
          ? `Cloudflare ${method} ${url} returned ${res.status}: ${detail}. ${authHint}`
          : `Cloudflare ${method} ${url} returned ${res.status}: ${detail}. The API token must have Account » Zero Trust » Edit (Gateway Lists live under Zero Trust — "Account Filter Lists" is the WAF Rules Lists API and will not work for Tunnel access policies). Verify the account id is correct as well.`,
      );
    }
    if (res.status === 429) {
      throw new DriverRateLimitError(
        `Cloudflare ${method} ${url} rate limited.`,
      );
    }

    if (!res.ok || !payload || payload.success === false) {
      throw new CloudflareApiError(`Cloudflare ${method} ${url} failed: ${detail}`);
    }
    return payload;
  }
}
