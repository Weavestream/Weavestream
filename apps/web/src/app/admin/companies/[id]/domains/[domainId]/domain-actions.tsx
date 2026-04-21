'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiFetch } from '../../../../../../lib/api';
import { Icon } from '../../../../../../components/ui';
import type { MonitoredDomain } from '../../../../../../lib/server-api';

/**
 * Detail-page action bar. Lives in its own client component so the
 * outer page can stay an RSC. Keeps the "Check now" / "Archive" /
 * "Restore" UX colocated with the detail header.
 */
export function DomainActions({
  companyId,
  domain,
}: {
  companyId: string;
  domain: MonitoredDomain;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, method: 'POST' | 'DELETE') {
    setBusy(true);
    setError(null);
    const res = await apiFetch<unknown>(path, { method });
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(res.problem) ?? `${method} ${path} failed`);
      return;
    }
    startTransition(() => router.refresh());
  }

  const disabled = busy || pending;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 16,
      }}
    >
      {!domain.archivedAt && (
        <button
          type="button"
          onClick={() => call(`/companies/${companyId}/domains/${domain.id}/check`, 'POST')}
          disabled={disabled}
          style={primaryBtn}
        >
          <Icon.zap size={12} />{' '}
          {busy ? 'Running…' : 'Check now'}
        </button>
      )}
      {!domain.archivedAt && (
        <button
          type="button"
          onClick={() => call(`/companies/${companyId}/domains/${domain.id}`, 'DELETE')}
          disabled={disabled}
          style={secondaryBtn}
        >
          Archive
        </button>
      )}
      {domain.archivedAt && (
        <button
          type="button"
          onClick={() => call(`/companies/${companyId}/domains/${domain.id}/restore`, 'POST')}
          disabled={disabled}
          style={secondaryBtn}
        >
          Restore
        </button>
      )}
      {error && (
        <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>
      )}
    </div>
  );
}

function messageOf(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null;
  const p = problem as Record<string, unknown>;
  if (typeof p.message === 'string') return p.message;
  if (typeof p.detail === 'string') return p.detail;
  return null;
}

const primaryBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 30,
  padding: '0 12px',
  background: 'var(--accent)',
  color: 'var(--accent-ink)',
  borderRadius: 5,
  fontSize: 12.5,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  height: 30,
  padding: '0 12px',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  borderRadius: 5,
  fontSize: 12.5,
  border: '1px solid var(--line)',
  cursor: 'pointer',
};
