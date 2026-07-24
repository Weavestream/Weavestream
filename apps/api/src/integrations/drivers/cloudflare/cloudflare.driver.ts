import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { DriverDescriptor } from '@weavestream/shared';
import {
  CloudflareApiClient,
  type CloudflareCallContext,
  type CloudflareList,
  type CloudflareListItem,
} from './cloudflare-api.client.js';

export const cloudflareConfigSchema = z.object({
  accountId: z.string().min(1, 'Cloudflare account id is required'),
});
export type CloudflareConfig = z.infer<typeof cloudflareConfigSchema>;

export const cloudflareSecretSchema = z.object({
  apiToken: z.string().min(1, 'Cloudflare API token is required'),
});
export type CloudflareSecret = z.infer<typeof cloudflareSecretSchema>;

/**
 * Cloudflare Zero Trust Gateway Lists driver.
 *
 * Manages the IP-typed Gateway lists that Cloudflare Tunnel access
 * policies and Zero Trust Gateway rules consume. Does NOT touch the
 * `/rules/lists` API (that's a different feature used by WAF).
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
    label: 'Cloudflare Zero Trust Lists',
    description:
      'Manage Cloudflare Zero Trust Gateway IP lists with richer descriptions, audit history, and one-click drift recovery. Weavestream is the source of truth — every change is pushed to Cloudflare.',
    iconKey: 'cloudflare',
    configFields: [
      {
        key: 'accountId',
        label: 'Cloudflare Account ID',
        kind: 'text',
        required: true,
        description:
          'Found on the Cloudflare dashboard overview page. All Gateway lists managed by this integration must live under this account.',
      },
    ],
    secretFields: [
      {
        key: 'apiToken',
        label: 'API Token',
        kind: 'password',
        required: true,
        description:
          'Cloudflare API token scoped to Account » Zero Trust » Edit (this is what Tunnel access policies and Gateway rules consume — NOT "Account Filter Lists", which is the unrelated WAF Rules Lists API). Stored AES-256-GCM encrypted; never returned to the UI.',
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

  async testConnection(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    http: { timeoutMs: number; maxRetries: number; backoffMs: number },
    correlationId: string,
  ): Promise<{ ok: true; details?: string }> {
    const { accountId } = cloudflareConfigSchema.parse(config);
    const { apiToken } = cloudflareSecretSchema.parse(secret);
    const lists = await this.api.listAllLists(accountId, {
      apiToken,
      http,
      correlationId,
    });
    const ipCount = lists.filter((l) => l.kind === 'ip').length;
    return {
      ok: true,
      details: `Reached Cloudflare account (${lists.length} Gateway list${lists.length === 1 ? '' : 's'} total, ${ipCount} IP list${ipCount === 1 ? '' : 's'}).`,
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

  parseAccountId(config: Record<string, unknown>): string {
    return cloudflareConfigSchema.parse(config).accountId;
  }
}

export type { CloudflareCallContext };
