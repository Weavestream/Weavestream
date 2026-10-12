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
import { MapLayoutsTab, matchableResources } from './map-layouts-tab';
import { DifferencesTab } from './differences-tab';

/** Drivers whose resources fill standard layout fields get a Differences tab. */
export function hasStandardFields(driver: DriverDescriptor | null): boolean {
  return (driver?.resources ?? []).some((resource) => (resource.standardFields?.length ?? 0) > 0);
}

type StaticTabId = 'creds' | 'orgs' | 'layouts' | 'differences' | 'completeness' | 'runs';
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

const MAP_LAYOUTS_TAB: TabDescriptor = {
  id: 'layouts',
  label: 'Map layouts',
  help: 'Choose the layout and match field for each kind of record.',
  kind: 'static',
};

const DIFFERENCES_TAB: TabDescriptor = {
  id: 'differences',
  label: 'Differences',
  help: 'Fields changed in Weavestream that now differ from the source.',
  kind: 'static',
};

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
        help: `Destination folder and visibility for ${resource.label.toLowerCase()}.`,
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
        help: `Dependency resources for ${resource.label.toLowerCase()}.`,
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
  canManageLayouts = true,
  differenceCount = null,
}: {
  initialTab: string;
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  runs: IntegrationSyncRunDto[];
  driver: DriverDescriptor | null;
  canManageLayouts?: boolean;
  /** Open differences, for the tab badge; null when unknown. */
  differenceCount?: number | null;
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
    // Completeness only exists for drivers that opt into the
    // reconstruction-completeness model (currently Breeze). Other
    // drivers never carry scorecards, so the tab would only ever show
    // an empty dashboard.
    const tail = driver?.capabilities?.reconstructionCompleteness
      ? STATIC_TABS_TAIL
      : STATIC_TABS_TAIL.filter((t) => t.id !== 'completeness');
    // Guided matcher only for drivers whose resources declare match suggestions.
    const head = matchableResources(driver).length > 0 ? [...STATIC_TABS_HEAD, MAP_LAYOUTS_TAB] : STATIC_TABS_HEAD;
    const differences = hasStandardFields(driver)
      ? [{ ...DIFFERENCES_TAB, label: differenceCount ? `Differences (${differenceCount})` : 'Differences' }]
      : [];
    return [...head, ...resourceTabs, ...differences, ...tail];
  }, [driver, differenceCount]);

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
          // Draw the baseline inside the strip and keep tabs in it. A border plus
          // `top: 1` on the tabs overflowed the overflow-x scroll box by 1px,
          // which forced a permanent vertical scrollbar.
          boxShadow: 'inset 0 -1px 0 var(--line)',
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
        {tab === 'layouts' && <MapLayoutsTab integration={integration} driver={driver} canManageLayouts={canManageLayouts} />}
        {tab === 'differences' && (
          <DifferencesTab integrationId={integration.id} mappings={mappings} sourceLabel={driver?.label ?? integration.name} />
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
