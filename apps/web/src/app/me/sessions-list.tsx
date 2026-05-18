'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../lib/api';
import {
  Btn,
  DataTable,
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

export function SessionsList({ sessions }: { sessions: Session[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

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
        <span style={{ color: 'var(--dim)' }}>{relative(s.createdAt)}</span>
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
          onClick={async () => {
            setPending(true);
            const res = await apiFetch('/me/sessions/revoke-others', { method: 'POST' });
            setPending(false);
            if (!res.ok) {
              toast.push('Could not revoke sessions.', 'danger');
              return;
            }
            toast.push('Other sessions revoked.', 'ok');
            router.refresh();
          }}
        >
          {others === 0 ? 'No other sessions' : `Revoke ${others} other session${others === 1 ? '' : 's'}`}
        </Btn>
      </div>
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
              {relative(s.createdAt)}
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

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}
