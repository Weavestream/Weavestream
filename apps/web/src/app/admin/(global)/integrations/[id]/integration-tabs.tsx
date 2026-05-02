'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  DriverDescriptor,
  DriverResourceDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationSyncRunDto,
} from '@weavestream/shared';
import { CredentialsTab } from './credentials-tab';
import { FieldMappingsTab } from './field-mappings-tab';
import { OrgsTab } from './orgs-tab';
import { RunsTab } from './runs-tab';

type StaticTabId = 'creds' | 'orgs' | 'runs';
type ResourceTabId = `fields:${string}`;
type TabId = StaticTabId | ResourceTabId;

type TabDescriptor =
  | {
      id: StaticTabId;
      label: string;
      help: string;
      kind: 'static';
    }
  | {
      id: ResourceTabId;
      label: string;
      help: string;
      kind: 'resource';
      resource: DriverResourceDescriptor;
    };

const STATIC_TABS_HEAD: TabDescriptor[] = [
  {
    id: 'creds',
    label: 'Credentials & schedule',
    help: 'Update the secret, status, or cron expression.',
    kind: 'static',
  },
  {
    id: 'orgs',
    label: 'Organizations',
    help: 'Map each upstream organization to a Weavestream company.',
    kind: 'static',
  },
];

const STATIC_TABS_TAIL: TabDescriptor[] = [
  {
    id: 'runs',
    label: 'Run history',
    help: 'Inspect totals, conflicts, and errors for every sync run.',
    kind: 'static',
  },
];

function resourceTabId(key: string): ResourceTabId {
  return `fields:${key}` as ResourceTabId;
}

function isResourceTabId(id: string): id is ResourceTabId {
  return id.startsWith('fields:');
}

function resourceKeyFromTab(id: ResourceTabId): string {
  return id.slice('fields:'.length);
}

export function IntegrationTabs({
  initialTab,
  integration,
  mappings,
  runs,
  driver,
}: {
  initialTab: string;
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  runs: IntegrationSyncRunDto[];
  driver: DriverDescriptor | null;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  // Driver descriptor is the source of truth for which resource tabs
  // to render. Drivers without an explicit `resources` array implicitly
  // get a single `records` tab — we mirror that here.
  const tabs = useMemo<TabDescriptor[]>(() => {
    const resources: DriverResourceDescriptor[] =
      driver?.resources && driver.resources.length > 0
        ? driver.resources
        : [{ key: 'records', label: 'Records' }];
    const resourceTabs: TabDescriptor[] = resources.map((r) => ({
      id: resourceTabId(r.key),
      label: `${r.label} fields`,
      help: `Layout, match keys, and field mappings for ${r.label.toLowerCase()}.`,
      kind: 'resource',
      resource: r,
    }));
    return [...STATIC_TABS_HEAD, ...resourceTabs, ...STATIC_TABS_TAIL];
  }, [driver]);

  // Resolve the initial tab against the descriptor list. Legacy `fields`
  // (singular) routes default to the first resource tab so saved bookmarks
  // keep working post-migration.
  const resolvedInitialTab = useMemo<TabId>(() => {
    if (tabs.find((t) => t.id === initialTab)) return initialTab as TabId;
    if (initialTab === 'fields') {
      const first = tabs.find((t) => t.kind === 'resource');
      if (first) return first.id;
    }
    return 'creds';
  }, [initialTab, tabs]);

  const [tab, setTab] = useState<TabId>(resolvedInitialTab);

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
        {tabs.map((t) => {
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
        {isResourceTabId(tab) &&
          (() => {
            const key = resourceKeyFromTab(tab);
            const descriptor =
              driver?.resources?.find((r) => r.key === key) ??
              (tabs.find((t) => t.id === tab && t.kind === 'resource') as
                | (TabDescriptor & { kind: 'resource' })
                | undefined)?.resource ??
              { key, label: key };
            return (
              <FieldMappingsTab
                integration={integration}
                mappings={mappings}
                driver={driver}
                resource={descriptor}
              />
            );
          })()}
      </div>
    </div>
  );
}
