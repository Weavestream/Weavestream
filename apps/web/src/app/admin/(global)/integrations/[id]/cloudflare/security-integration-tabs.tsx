'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  CloudflareIpListDto,
  DriverDescriptor,
  IntegrationDto,
} from '@weavestream/shared';
import { CredentialsTab } from '../credentials-tab';
import { RegisteredListsTab } from './registered-lists-tab';

type TabId = 'creds' | 'lists';

const TABS: { id: TabId; label: string; help: string }[] = [
  {
    id: 'creds',
    label: 'Credentials & schedule',
    help: 'Update the API token, drift-check schedule, or pause the integration.',
  },
  {
    id: 'lists',
    label: 'Lists',
    help: 'Register Cloudflare IP lists and edit their entries.',
  },
];

/**
 * Tabs shell for security-kind integrations (Cloudflare). Replaces the
 * asset-import tabs (Mappings, Field Mappings, Run history) with the
 * single "Lists" tab; reuses `CredentialsTab` since credentials,
 * status, and cron configuration work identically across kinds.
 */
export function SecurityIntegrationTabs({
  initialTab,
  integration,
  driver,
  cloudflareLists,
}: {
  initialTab: string;
  integration: IntegrationDto;
  driver: DriverDescriptor | null;
  cloudflareLists: CloudflareIpListDto[];
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const initial = TABS.find((t) => t.id === initialTab)?.id ?? 'creds';
  const [tab, setTab] = useState<TabId>(initial);

  function navigate(next: TabId): void {
    setTab(next);
    const params = new URLSearchParams(sp.toString());
    params.set('tab', next);
    router.replace(`/admin/integrations/${integration.id}?${params.toString()}`);
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Integration sections"
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
        {tab === 'creds' && (
          <CredentialsTab integration={integration} mappings={[]} driver={driver} />
        )}
        {tab === 'lists' && (
          <RegisteredListsTab
            integration={integration}
            initialLists={cloudflareLists}
          />
        )}
      </div>
    </div>
  );
}
