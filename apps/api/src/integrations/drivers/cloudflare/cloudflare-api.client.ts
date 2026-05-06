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
        `Cloudflare ${method} ${url} returned ${res.status}. The API token must have Account » Zero Trust » Edit (Gateway Lists live under Zero Trust — "Account Filter Lists" is the WAF Rules Lists API and will not work for Tunnel access policies). Verify the account id is correct as well.`,
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
      throw new Error(`Cloudflare ${method} ${url} failed: ${detail}`);
    }
    return payload;
  }
}
