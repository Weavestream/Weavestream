import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { DriverDescriptor } from '@weavestream/shared';
import { DriverAuthError } from '../integration-driver.js';
import {
  CloudflareApiClient,
  type CloudflareCallContext,
  type CloudflareList,
  type CloudflareListItem,
  type CloudflareRegistrarDomain,
} from './cloudflare-api.client.js';

export const cloudflareConfigSchema = z.object({
  accountId: z.string().min(1, 'Cloudflare account id is required'),
  /**
   * Company that newly discovered domains are filed under. Empty = registrar
   * sync off, so existing Zero Trust-only integrations are unaffected.
   */
  domainsCompanySlug: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  /**
   * Resolved from `domainsCompanySlug` by the integrations controller when the
   * config is saved, after checking the saver may manage domains there. The
   * sync uses this id, never the slug: slugs are editable, and a client
   * cannot supply it (the controller always overwrites or strips it).
   */
  domainsCompanyId: z.string().uuid().optional(),
});
export type CloudflareConfig = z.infer<typeof cloudflareConfigSchema>;

export const cloudflareSecretSchema = z.object({
  apiToken: z.string().min(1, 'Cloudflare API token is required'),
});
export type CloudflareSecret = z.infer<typeof cloudflareSecretSchema>;

/**
 * Cloudflare driver.
 *
 * Two features on one Cloudflare account:
 *  - the IP-typed Gateway lists that Cloudflare Tunnel access policies and
 *    Zero Trust Gateway rules consume (NOT the `/rules/lists` API, which is
 *    a different feature used by WAF);
 *  - registrar → Domains sync, on when `domainsCompanyId` is set.
 *
 * Unlike asset-import drivers, this does NOT implement
 * `IntegrationDriver`. Weavestream is the source of truth for the IP
 * entries; the framework still owns the credential row (in `Integration`
 * + `IntegrationSecret`) so token rotation and the test-connection UX
 * are reused as-is. A separate registry slot (`securityDrivers`) keeps
 * the asset-import dispatch unchanged.
 */
@Injectable()
export class CloudflareDriver {
  readonly key = 'cloudflare' as const;

  constructor(private readonly api: CloudflareApiClient) {}

  readonly descriptor: DriverDescriptor = {
    key: 'cloudflare',
    label: 'Cloudflare',
    description:
      'Manage Zero Trust Gateway IP lists with per-entry descriptions, audit history and one-click drift recovery; every change is pushed to Cloudflare. Optionally, sync every domain on the account into Domains, with expiry, auto-renew and nameservers.',
    iconKey: 'cloudflare',
    configFields: [
      {
        key: 'accountId',
        label: 'Cloudflare Account ID',
        kind: 'text',
        required: true,
        description:
          'Found on the Cloudflare dashboard overview page. The Gateway lists and domains this integration manages must be on this account.',
      },
      {
        key: 'domainsCompanySlug',
        label: 'Sync domains into company',
        kind: 'company',
        required: false,
        description:
          'Optional. When set, every domain on this Cloudflare account (Registrar registrations and DNS zones) is synced into Domains on each run, with registration, expiry, auto-renew and nameservers. New domains go to this company; a domain you move to another company stays there. The token then also needs Zone » Zone » Read and read access to Registrar on this account; Test connection checks both. Leave empty to turn domain sync off.',
      },
    ],
    secretFields: [
      {
        key: 'apiToken',
        label: 'API Token',
        kind: 'password',
        required: true,
        description:
          'Cloudflare API token for this account. For Gateway IP lists: Account » Zero Trust » Edit (NOT "Account Filter Lists", which is the unrelated WAF Rules Lists API). For domain sync: Zone » Zone » Read and read access to Registrar. Grant only what you use. Stored AES-256-GCM encrypted; never returned to the UI.',
      },
    ],
    resources: [],
    capabilities: {
      kind: 'security',
      listSourceOrgs: false,
      dryRun: false,
      ticketing: false,
      reconstructionCompleteness: false,
    },
  };

  // -------------------------------------------------------------------
  // Driver methods (called from CloudflareListsService + controller)
  // -------------------------------------------------------------------

  /**
   * Checks the capabilities the token is for. The two features are
   * independent, so each needs only its own permissions:
   *  - domain sync off: the Gateway lists must be readable;
   *  - domain sync on: the zone and registrar lists must be readable, and a
   *    token without Zero Trust access is reported, not failed, since a
   *    domains-only integration never calls the Gateway API.
   * A token that passes here can run what the integration is set up to do.
   */
  async testConnection(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    http: { timeoutMs: number; maxRetries: number; backoffMs: number },
    correlationId: string,
  ): Promise<{ ok: true; details?: string }> {
    const { accountId, domainsCompanyId } = cloudflareConfigSchema.parse(config);
    const { apiToken } = cloudflareSecretSchema.parse(secret);
    const ctx = { apiToken, http, correlationId };

    let listsDetail: string;
    try {
      const lists = await this.api.listAllLists(accountId, ctx);
      const ipCount = lists.filter((l) => l.kind === 'ip').length;
      listsDetail = `Gateway lists: reached (${lists.length} list${lists.length === 1 ? '' : 's'} total, ${ipCount} IP list${ipCount === 1 ? '' : 's'}).`;
    } catch (e) {
      if (!domainsCompanyId || !(e instanceof DriverAuthError)) throw e;
      listsDetail =
        'Gateway lists: this token has no Zero Trust access, which only IP lists need.';
    }
    if (!domainsCompanyId) return { ok: true, details: listsDetail };

    let access: { zones: number };
    try {
      access = await this.api.checkRegistrarAccess(accountId, ctx);
    } catch (e) {
      // Keep the original error class (DriverAuthError, rate limit) and say
      // which check failed.
      if (e instanceof Error) {
        e.message = `Domain sync check failed: ${e.message}`;
      }
      throw e;
    }
    return {
      ok: true,
      details: `${listsDetail} Domain sync: zone and registrar access confirmed (${access.zones} zone${access.zones === 1 ? '' : 's'}).`,
    };
  }

  async listExternalLists(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    http: { timeoutMs: number; maxRetries: number; backoffMs: number },
    correlationId: string,
  ): Promise<CloudflareList[]> {
    const { accountId } = cloudflareConfigSchema.parse(config);
    const { apiToken } = cloudflareSecretSchema.parse(secret);
    return this.api.listAllLists(accountId, { apiToken, http, correlationId });
  }

  async listExternalListItems(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    listId: string,
    http: { timeoutMs: number; maxRetries: number; backoffMs: number },
    correlationId: string,
  ): Promise<CloudflareListItem[]> {
    const { accountId } = cloudflareConfigSchema.parse(config);
    const { apiToken } = cloudflareSecretSchema.parse(secret);
    return this.api.listListItems(accountId, listId, {
      apiToken,
      http,
      correlationId,
    });
  }

  /**
   * Synchronously bring Cloudflare's view of a Gateway list to the
   * desired set of IPs. The driver fetches the current Cloudflare
   * items and PATCHes the diff (`append` + `remove`) — Gateway
   * lists don't expose an atomic full-replace endpoint, but PATCH is
   * itself transactional from the operator's point of view.
   *
   * Returns the post-update items echoed back by Cloudflare so the
   * caller can persist canonicalised values.
   */
  async syncListItems(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    listId: string,
    desired: ReadonlyArray<{ ip: string }>,
    http: { timeoutMs: number; maxRetries: number; backoffMs: number },
    correlationId: string,
  ): Promise<{ items: CloudflareListItem[] }> {
    const { accountId } = cloudflareConfigSchema.parse(config);
    const { apiToken } = cloudflareSecretSchema.parse(secret);
    const ctx = { apiToken, http, correlationId };
    const cfCurrent = await this.api.listListItems(accountId, listId, ctx);
    return this.api.syncListItems(accountId, listId, desired, cfCurrent, ctx);
  }

  /** Every domain the account holds, with its registrar record where Cloudflare is the registrar. */
  async listRegistrarDomains(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    http: { timeoutMs: number; maxRetries: number; backoffMs: number },
    correlationId: string,
  ): Promise<CloudflareRegistrarDomain[]> {
    const { accountId } = cloudflareConfigSchema.parse(config);
    const { apiToken } = cloudflareSecretSchema.parse(secret);
    return this.api.listRegistrarDomains(accountId, { apiToken, http, correlationId });
  }

  parseAccountId(config: Record<string, unknown>): string {
    return cloudflareConfigSchema.parse(config).accountId;
  }
}

export type { CloudflareCallContext };
