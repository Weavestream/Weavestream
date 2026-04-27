'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { EmailSettings } from '@weavestream/shared';
import type { Settings } from '../../../../lib/server-api';
import { GeneralSettingsForm, SecuritySettingsForm } from './settings-form';
import { EmailSettingsForm } from './email-settings-form';

type TabId = 'general' | 'security' | 'email';

const TABS: Array<{ id: TabId; label: string; help: string }> = [
  {
    id: 'general',
    label: 'General',
    help: 'Workspace branding and tenant terminology.',
  },
  {
    id: 'security',
    label: 'Security',
    help: 'Password generator defaults and security-related settings.',
  },
  {
    id: 'email',
    label: 'Email',
    help: 'SMTP configuration and test emails.',
  },
];

export function SettingsTabs({
  initialTab,
  settings,
  emailSettings,
  currentUserEmail,
}: {
  initialTab: TabId;
  settings: Settings;
  emailSettings: EmailSettings;
  currentUserEmail: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [tab, setTab] = useState<TabId>(initialTab);

  function navigate(next: TabId) {
    setTab(next);
    const params = new URLSearchParams(sp.toString());
    params.set('tab', next);
    router.replace(`/admin/settings?${params.toString()}`);
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Settings sections"
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
      <div style={{ padding: 18 }}>
        {tab === 'general' && <GeneralSettingsForm initial={settings} />}
        {tab === 'security' && <SecuritySettingsForm initial={settings} />}
        {tab === 'email' && (
          <EmailSettingsForm
            initial={emailSettings}
            defaultRecipient={currentUserEmail}
          />
        )}
      </div>
    </div>
  );
}
