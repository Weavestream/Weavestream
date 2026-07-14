'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Panel, Tag } from '../../components/ui';
import { FormattedDateTime } from '../../lib/timezone-context';
import { membershipRoleLabel, roleLabel } from '../../lib/roles';
import type { Me } from '../../lib/server-api';
import { ProfileForm } from './profile-form';
import { PasswordForm } from './password-form';
import { SessionsList } from './sessions-list';
import { AppearanceForm } from './appearance-form';
import { MfaBackupCodes } from './mfa-backup-codes';

type TabId = 'profile' | 'memberships' | 'appearance' | 'security' | 'sessions';

type Session = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

const TABS: Array<{ id: TabId; label: string; help: string }> = [
  {
    id: 'profile',
    label: 'Profile',
    help: 'Your name, email, and timezone.',
  },
  {
    id: 'memberships',
    label: 'Memberships',
    help: 'Companies your account can access.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    help: 'Theme and accent personalization.',
  },
  {
    id: 'security',
    label: 'Security',
    help: 'Password, MFA, and backup codes.',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    help: 'Active sessions on your account.',
  },
];

export function MeTabs({
  initialTab,
  me,
  sessions,
}: {
  initialTab: TabId;
  me: Me;
  sessions: Session[];
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [tab, setTab] = useState<TabId>(initialTab);

  function navigate(next: TabId) {
    setTab(next);
    const params = new URLSearchParams(sp.toString());
    params.set('tab', next);
    router.replace(`/me?${params.toString()}`);
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Profile sections"
        style={{
          display: 'flex',
          gap: 2,
          padding: '6px 6px 0',
          borderBottom: '1px solid var(--line)',
          background: 'var(--panel-2)',
          overflowX: 'auto',
        }}
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => navigate(t.id)}
              style={{
                padding: '10px 14px',
                fontSize: 13,
                fontWeight: 500,
                color: active ? 'var(--text)' : 'var(--muted)',
                background: active ? 'var(--panel)' : 'transparent',
                border: '1px solid',
                borderColor: active ? 'var(--line)' : 'transparent',
                borderBottom: active ? '1px solid var(--panel)' : 'none',
                borderRadius: '6px 6px 0 0',
                cursor: 'pointer',
                position: 'relative',
                top: 1,
                whiteSpace: 'nowrap',
              }}
              title={t.help}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        style={{
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {tab === 'profile' && (
          <Panel title="Identity" flush>
            <ProfileForm me={me} />
          </Panel>
        )}

        {tab === 'memberships' && (
          <Panel title={`Memberships (${me.memberships.length})`} flush>
            {me.memberships.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
                No explicit company memberships are assigned to your account.
              </p>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 12,
                }}
              >
                {me.memberships.map((membership) => (
                  <div
                    key={membership.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      padding: 14,
                      border: '1px solid var(--line)',
                      borderRadius: 6,
                      background: 'var(--panel-2)',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text)', fontSize: 14, fontWeight: 500 }}>
                        {membership.company.name}
                      </span>
                      <span
                        style={{
                          color: 'var(--dim)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                        }}
                      >
                        /{membership.company.slug}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <Tag tone="accent">{membershipRoleLabel(membership.role)}</Tag>
                      <span style={{ color: 'var(--dim)', fontSize: 11.5 }}>
                        {membership.expiresAt ? (
                          <>
                            Expires <FormattedDateTime value={membership.expiresAt} />
                          </>
                        ) : (
                          'No expiration'
                        )}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {tab === 'appearance' && (
          <Panel title="Appearance" flush>
            <p
              style={{
                margin: '0 0 18px',
                fontSize: 12.5,
                color: 'var(--dim)',
                maxWidth: 560,
              }}
            >
              Personalize how Weavestream looks on this account. Changes sync across every browser you sign in on.
            </p>
            <AppearanceForm initial={me.preferences} />
          </Panel>
        )}

        {tab === 'security' && (
          <Panel title="Security" flush>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
              <Section>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: 20,
                  }}
                >
                  <Field label="Role" value={<Tag tone="accent">{roleLabel(me.role)}</Tag>} />
                  <Field
                    label="Two-factor"
                    value={
                      me.mfaEnabled ? (
                        <Tag tone="ok">
                          enabled
                        </Tag>
                      ) : (
                        <Tag tone="warn">
                          pending
                        </Tag>
                      )
                    }
                  />
                  <Field
                    label="Enrolled at"
                    value={
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: 'var(--dim)',
                        }}
                      >
                        {me.mfaEnforcementCompletedAt ? (
                          <FormattedDateTime value={me.mfaEnforcementCompletedAt} />
                        ) : (
                          'never'
                        )}
                      </span>
                    }
                  />
                </div>
              </Section>

              {me.mfaEnabled && (
                <Section
                  title="MFA backup codes"
                  description="Generate a fresh set of single-use recovery codes. The old set is replaced."
                >
                  <MfaBackupCodes enabled={me.mfaEnabled} />
                </Section>
              )}

              <Section
                title="Change password"
                description="Update your account password. Other sessions are signed out after a successful change."
              >
                <PasswordForm />
              </Section>
            </div>
          </Panel>
        )}

        {tab === 'sessions' && (
          <Panel title={`Active sessions (${sessions.length})`} flush noPad>
            <SessionsList sessions={sessions} />
          </Panel>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--muted)',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {title && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            marginBottom: 14,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--muted)',
              letterSpacing: 0.6,
              textTransform: 'uppercase',
            }}
          >
            {title}
          </h3>
          {description && (
            <p
              style={{
                margin: 0,
                maxWidth: 560,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'var(--dim)',
              }}
            >
              {description}
            </p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
