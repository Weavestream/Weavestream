'use client';

import { useState } from 'react';
import type { IntegrationDto } from '@weavestream/shared';
import { apiFetch } from '../../../../../../lib/api';
import { Btn, Tag, useToast } from '../../../../../../components/ui';

/**
 * Domains tab for a Cloudflare integration. The registrar sync runs on the
 * integration's schedule; this is the "do it now" button plus the setting it
 * depends on, so an operator never wonders why nothing appeared.
 */
export function DomainsSyncTab({ integration }: { integration: IntegrationDto }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const config = integration.config as { domainsCompanySlug?: string; domainsCompanyId?: string } | null;
  // Only a server-resolved company id turns the sync on.
  const slug = config?.domainsCompanyId ? config.domainsCompanySlug : undefined;

  async function sync(): Promise<void> {
    setPending(true);
    let res: Awaited<ReturnType<typeof apiFetch<{ queued: true }>>>;
    try {
      res = await apiFetch<{ queued: true }>(
        `/admin/integrations/${integration.id}/cloudflare/domains/sync`,
        { method: 'POST' },
      );
    } catch {
      toast.push('Could not start the domain sync.', 'danger');
      return;
    } finally {
      setPending(false);
    }
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(problem?.detail ?? problem?.title ?? 'Domain sync failed.', 'danger');
      return;
    }
    setQueued(true);
    toast.push('Domain sync started.', 'ok');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640 }}>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
        Every domain on this Cloudflare account is kept in Domains with its registration,
        expiry, auto-renew and nameservers, marked with an orange{' '}
        <Tag tone="cloudflare">Cloudflare</Tag> tag. New domains are filed under the company
        set in Credentials; a domain you move to another company stays there. Nothing is
        ever deleted: a domain that leaves the account is flagged instead.
      </p>
      {slug ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={() => void sync()} disabled={pending}>
            {pending ? 'Syncing…' : 'Sync domains now'}
          </Btn>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            New domains go to <code>{slug}</code>
          </span>
        </div>
      ) : (
        <Tag tone="warn">
          Off. Set “Sync domains into company” under Credentials to turn it on.
        </Tag>
      )}
      {queued && (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Running in the background. Domains appear as it finishes, usually within a minute
          or two; the audit log records what changed.
        </span>
      )}
    </div>
  );
}
