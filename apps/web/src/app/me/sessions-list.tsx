'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  API_KEY_REVOCATION_WARNING,
  apiKeysRevokedNotice,
  type RevokeOtherSessionsResult,
} from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { FormattedRelative } from '../../lib/timezone-context';
import {
  Btn,
  DataTable,
  Dialog,
  Icon,
  MobileCardRow,
  Tag,
  useToast,
  type DataColumn,
} from '../../components/ui';

type Session = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

export function SessionsList({
  sessions,
  apiKeyCount,
}: {
  sessions: Session[];
  /**
   * Live API keys the user holds, or null when the list failed to load.
   * Revoking other sessions also revokes every key, so the confirmation has
   * to say so before the user commits.
   */
  apiKeyCount: number | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function revokeOthers() {
    setPending(true);
    const res = await apiFetch<RevokeOtherSessionsResult>('/me/sessions/revoke-others', {
      method: 'POST',
    });
    setPending(false);
    if (!res.ok) {
      toast.push('Could not revoke sessions.', 'danger');
      return;
    }
    // The server's count is the truth: a key minted in another tab after
    // this page loaded is revoked too, and the user should hear about it.
    toast.push(`Other sessions revoked.${apiKeysRevokedNotice(res.data?.apiKeysRevoked ?? 0)}`, 'ok');
    router.refresh();
  }

  const columns: DataColumn<Session>[] = [
    {
      id: 'session',
      header: 'Session',
      sortValue: (s) => summariseUserAgent(s.userAgent).toLowerCase(),
      render: (s) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>
            {summariseUserAgent(s.userAgent)}
          </span>
          <span
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--dim)' }}
          >
            {s.ip ?? 'unknown ip'}
          </span>
        </div>
      ),
    },
    {
      id: 'age',
      header: 'Started',
      mono: true,
      width: 150,
      sortValue: (s) => new Date(s.createdAt),
      render: (s) => (
        <span style={{ color: 'var(--dim)' }}><FormattedRelative value={s.createdAt} /></span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 140,
      sortValue: (s) => (s.current ? 1 : 0),
      render: (s) =>
        s.current ? (
          <Tag tone="ok">
            this device
          </Tag>
        ) : (
          <Tag tone="outline">other</Tag>
        ),
    },
  ];

  const others = sessions.filter((s) => !s.current).length;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: 10,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <Btn
          kind="outline"
          size="sm"
          icon={Icon.shield}
          disabled={others === 0}
          loading={pending}
          onClick={() => setConfirming(true)}
        >
          {others === 0 ? 'No other sessions' : `Revoke ${others} other session${others === 1 ? '' : 's'}`}
        </Btn>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Revoke other sessions"
        width={440}
        footer={
          <>
            <Btn kind="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Btn>
            <Btn
              kind="danger"
              onClick={() => {
                setConfirming(false);
                void revokeOthers();
              }}
            >
              {apiKeyCount ? 'Revoke sessions and keys' : 'Revoke sessions'}
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            Sign out {others} other session{others === 1 ? '' : 's'}. This device stays signed in.
          </p>
          {apiKeyCount !== 0 && (
            <p style={{ margin: 0 }}>
              {apiKeyCount ? (
                <strong>
                  You have {apiKeyCount} API key{apiKeyCount === 1 ? '' : 's'}.{' '}
                </strong>
              ) : null}
              {API_KEY_REVOCATION_WARNING}
            </p>
          )}
        </div>
      </Dialog>
      <DataTable
        columns={columns}
        rows={sessions}
        empty="No active sessions."
        renderMobileCard={(s) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div
                style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}
              >
                {summariseUserAgent(s.userAgent)}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--dim)',
                }}
              >
                {s.ip ?? 'unknown ip'}
              </div>
            </div>
            <div>
              {s.current ? (
                <Tag tone="ok">
                  this device
                </Tag>
              ) : (
                <Tag tone="outline">other</Tag>
              )}
            </div>
            <MobileCardRow label="Started" mono>
              <FormattedRelative value={s.createdAt} />
            </MobileCardRow>
          </div>
        )}
      />
    </div>
  );
}

function summariseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (/Chrome/i.test(ua)) return ua.match(/\(([^)]+)\)/)?.[1] ?? 'Chrome browser';
  if (/Firefox/i.test(ua)) return 'Firefox browser';
  if (/Safari/i.test(ua)) return 'Safari browser';
  return ua.slice(0, 48);
}
