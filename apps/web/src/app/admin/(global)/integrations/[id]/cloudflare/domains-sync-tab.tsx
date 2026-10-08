'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CloudflareDomainSyncResult,
  CloudflareDomainSyncRunDto as DomainSyncRun,
  IntegrationDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../../lib/api';
import { FormattedDateTime } from '../../../../../../lib/timezone-context';
import { Btn, Icon, Tag, useToast } from '../../../../../../components/ui';

const ACTIVE = new Set<DomainSyncRun['status']>(['queued', 'running']);
const POLL_MS = 4000;
/** Failed status reads in a row before the page says it cannot refresh. */
const SHOW_REFRESH_PROBLEM_AFTER = 2;

function summary(r: CloudflareDomainSyncResult): string {
  const base = `${r.created} new, ${r.updated} updated, ${r.adopted} taken over, ${r.missing} no longer on the account`;
  // Older runs predate the count. The audit row names each skipped domain and why.
  return r.skipped ? `${base}, ${r.skipped} skipped (see the audit log)` : base;
}

/**
 * Domains tab for a Cloudflare integration. The registrar sync runs on the
 * integration's schedule; this is the "do it now" button, the setting it
 * depends on, and the outcome of the latest run, so an operator never
 * wonders why nothing appeared.
 */
export function DomainsSyncTab({
  integration,
  initialRun,
}: {
  integration: IntegrationDto;
  /** Latest run, loaded with the page; null before the first one. */
  initialRun: DomainSyncRun | null;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [run, setRun] = useState<DomainSyncRun | null>(initialRun);
  // Status reads that failed in a row; polling keeps retrying regardless.
  const [readFailures, setReadFailures] = useState(0);
  // Set while a run this page started is still going, so its end is toasted.
  const watching = useRef<string | null>(null);
  const config = integration.config as { domainsCompanySlug?: string; domainsCompanyId?: string } | null;
  // Only a server-resolved company id turns the sync on.
  const slug = config?.domainsCompanyId ? config.domainsCompanySlug : undefined;

  // A failed read changes nothing: the run shown stays active, so the next
  // poll tick retries. Only a successful read can end polling.
  const load = useCallback(async (): Promise<void> => {
    let res: Awaited<ReturnType<typeof apiFetch<{ run: DomainSyncRun | null }>>>;
    try {
      res = await apiFetch<{ run: DomainSyncRun | null }>(
        `/admin/integrations/${integration.id}/cloudflare/domains/sync`,
      );
    } catch {
      setReadFailures((n) => n + 1);
      return;
    }
    if (!res.ok || !res.data) {
      setReadFailures((n) => n + 1);
      return;
    }
    setReadFailures(0);
    const latest = res.data.run;
    // While watching our own run, an answer about any other run (or none)
    // is a stale read; keep the queued placeholder and poll again.
    if (watching.current && latest?.id !== watching.current) return;
    setRun(latest);
    if (latest && watching.current === latest.id && !ACTIVE.has(latest.status)) {
      watching.current = null;
      if (latest.status === 'succeeded') {
        toast.push(`Domain sync finished: ${latest.result ? summary(latest.result) : 'done'}.`, 'ok');
      } else {
        toast.push('Domain sync failed. See the Domains tab for the reason.', 'danger');
      }
    }
  }, [integration.id, toast]);

  // Poll only while a run is in flight; stop as soon as it is terminal.
  const active = run !== null && ACTIVE.has(run.status);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  async function sync(): Promise<void> {
    setPending(true);
    let res: Awaited<ReturnType<typeof apiFetch<{ queued: true; runId: string }>>>;
    try {
      res = await apiFetch<{ queued: true; runId: string }>(
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
    // Show the run as queued at once, from the POST alone, so polling starts
    // even if the first status read fails.
    watching.current = res.data.runId;
    setRun({
      id: res.data.runId,
      kind: 'manual',
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
    toast.push('Domain sync started.', 'ok');
    void load();
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
          <Btn
            kind="primary"
            size="sm"
            icon={Icon.sync}
            onClick={() => void sync()}
            loading={pending || active}
          >
            {pending || active ? 'Syncing…' : 'Sync domains now'}
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
      {slug && run && <LatestRun run={run} />}
      {slug && active && readFailures >= SHOW_REFRESH_PROBLEM_AFTER && (
        <span role="status" style={{ fontSize: 13, color: 'var(--warn)' }}>
          Could not refresh the sync status. Retrying…
        </span>
      )}
    </div>
  );
}

function LatestRun({ run }: { run: DomainSyncRun }) {
  const label = run.kind === 'manual' ? 'Manual sync' : 'Scheduled sync';
  const when = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {run.status === 'succeeded' && <Tag tone="ok">Succeeded</Tag>}
        {run.status === 'failed' && <Tag tone="danger">Failed</Tag>}
        {run.status === 'cancelled' && <Tag>Cancelled</Tag>}
        {ACTIVE.has(run.status) && (
          <Tag tone="info">{run.status === 'queued' ? 'Queued' : 'Running'}</Tag>
        )}
        <span style={{ color: 'var(--muted)' }}>
          {label}, <FormattedDateTime value={when} />
        </span>
      </div>
      {run.status === 'succeeded' && run.result && (
        <span style={{ color: 'var(--muted)' }}>{summary(run.result)}.</span>
      )}
      {run.status === 'failed' && run.error && (
        <span
          style={{
            color: 'var(--danger)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            lineHeight: 1.5,
          }}
        >
          {run.error}
        </span>
      )}
      {ACTIVE.has(run.status) && (
        <span style={{ color: 'var(--muted)' }}>
          Running in the background. This page updates when it finishes; the audit log
          records what changed.
        </span>
      )}
    </div>
  );
}
