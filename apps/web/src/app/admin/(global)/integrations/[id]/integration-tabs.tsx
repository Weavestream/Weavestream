'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationSyncRunDto,
} from '@weavestream/shared';
import { CredentialsTab } from './credentials-tab';
import { FieldMappingsTab } from './field-mappings-tab';
import { OrgsTab } from './orgs-tab';
import { RunsTab } from './runs-tab';

type TabId = 'creds' | 'fields' | 'orgs' | 'runs';

const TABS: Array<{ id: TabId; label: string; help: string }> = [
  {
    id: 'creds',
    label: 'Credentials & schedule',
    help: 'Update the secret, status, or cron expression.',
  },
  {
    id: 'orgs',
    label: 'Organizations',
    help: 'Map each upstream organization to a Weavestream company.',
  },
  {
    id: 'fields',
    label: 'Field mappings',
    help: 'Pick the target asset layout and project source fields onto Weavestream fields. Applies globally to every mapped company.',
  },
  {
    id: 'runs',
    label: 'Run history',
    help: 'Inspect totals, conflicts, and errors for every sync run.',
  },
];

export function IntegrationTabs({
  initialTab,
  integration,
  mappings,
  runs,
  driver,
}: {
  initialTab: TabId;
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  runs: IntegrationSyncRunDto[];
  driver: DriverDescriptor | null;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [tab, setTab] = useState<TabId>(initialTab);

  function navigate(next: TabId) {
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
          <CredentialsTab
            integration={integration}
            mappings={mappings}
            driver={driver}
          />
        )}
        {tab === 'fields' && (
          <FieldMappingsTab
            integration={integration}
            mappings={mappings}
            driver={driver}
          />
        )}
        {tab === 'orgs' && (
          <OrgsTab
            integration={integration}
            mappings={mappings}
            driver={driver}
          />
        )}
        {tab === 'runs' && (
          <RunsTab integration={integration} runs={runs} mappings={mappings} />
        )}
      </div>
    </div>
  );
}
