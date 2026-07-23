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
import { CompletenessTab } from './completeness-tab';

type StaticTabId = 'creds' | 'orgs' | 'completeness' | 'runs';
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
    help: 'Update the secret, status, or sync schedule.',
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
    id: 'completeness',
    label: 'Completeness',
    help: 'Review reconstruction coverage, lifecycle state, and safe gaps.',
    kind: 'static',
  },
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

function resourceTabPresentation(resource: DriverResourceDescriptor): Pick<TabDescriptor, 'label' | 'help'> {
  switch (resource.targetKind) {
    case 'article':
      return {
        label: `${resource.label} articles`,
        help: `Folder, visibility, and template configuration for ${resource.label.toLowerCase()}.`,
      };
    case 'subnet':
      return {
        label: `${resource.label} network`,
        help: `Normalization and native subnet identity for ${resource.label.toLowerCase()}.`,
      };
    case 'ip_reservation':
      return {
        label: `${resource.label} reservations`,
        help: `Normalization and native reservation identity for ${resource.label.toLowerCase()}.`,
      };
    case 'relation':
      return {
        label: `${resource.label} dependencies`,
        help: `Dependency resources and type mapping for ${resource.label.toLowerCase()}.`,
      };
    case 'asset':
      return {
        label: `${resource.label} fields`,
        help: `Layout, match keys, and field mappings for ${resource.label.toLowerCase()}.`,
      };
  }
}

function tabDomId(id: TabId): string {
  return `integration-tab-${id.replace(/[^a-z0-9_-]/gi, '-')}`;
}

function panelDomId(id: TabId): string {
  return `integration-panel-${id.replace(/[^a-z0-9_-]/gi, '-')}`;
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
        : [
            {
              key: 'records',
              label: 'Records',
              targetKind: 'asset',
              targetConfig: {},
              dependsOnResourceKeys: [],
            },
          ];
    const resourceTabs: TabDescriptor[] = resources.map((r) => ({
      id: resourceTabId(r.key),
      ...resourceTabPresentation(r),
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

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!;
    navigate(next.id);
    document.getElementById(tabDomId(next.id))?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Integration sections"
        aria-orientation="horizontal"
        style={{
          display: 'flex',
          gap: 2,
          padding: '6px 6px 0',
          borderBottom: '1px solid var(--line)',
          background: 'var(--panel-2)',
          overflowX: 'auto',
        }}
      >
        {tabs.map((t, index) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              id={tabDomId(t.id)}
              role="tab"
              aria-selected={active}
              aria-controls={panelDomId(t.id)}
              tabIndex={active ? 0 : -1}
              onClick={() => navigate(t.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
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
        id={panelDomId(tab)}
        role="tabpanel"
        aria-labelledby={tabDomId(tab)}
        tabIndex={0}
        style={{ padding: 18 }}
      >
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
        {tab === 'completeness' && (
          <CompletenessTab
            integrationId={integration.id}
            mappings={mappings}
            resources={integration.resources}
          />
        )}
        {isResourceTabId(tab) &&
          (() => {
            const key = resourceKeyFromTab(tab);
            const descriptor =
              driver?.resources?.find((r) => r.key === key) ??
              (tabs.find((t) => t.id === tab && t.kind === 'resource') as
                | (TabDescriptor & { kind: 'resource' })
                | undefined)?.resource ??
              {
                key,
                label: key,
                targetKind: 'asset' as const,
                targetConfig: {},
                dependsOnResourceKeys: [],
              };
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
