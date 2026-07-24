'use client';

import { useMemo } from 'react';
import type { DriverDescriptor, IntegrationDto } from '@weavestream/shared';
import {
  DataTable,
  MobileCardRow,
  Tag,
  type DataColumn,
} from '../../../../components/ui';
import {
  describeSyncCron,
  syncCronSortMinutes,
} from '../../../../components/integrations/sync-schedule';

/**
 * Phase 11 — table view for the global integration list.
 *
 * Status is decoupled from sync health:
 *   - status comes from `Integration.status` (operator-controlled).
 *   - sync chip comes from `lastRunStatus` and is informational.
 *
 * Clicking a row drops into the integration detail page where the
 * operator manages credentials, org mappings, and field mappings.
 */
export function IntegrationsTable({
  rows,
  drivers,
}: {
  rows: IntegrationDto[];
  drivers: DriverDescriptor[];
}) {
  const driverByKey = useMemo(
    () => new Map(drivers.map((d) => [d.key, d])),
    [drivers],
  );

  const columns = useMemo<DataColumn<IntegrationDto>[]>(
    () => [
      {
        id: 'name',
        header: 'Integration',
        sortValue: (r) => r.name.toLowerCase(),
        render: (r) => (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 0,
            }}
          >
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>
              {r.name}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {driverByKey.get(r.driver)?.label ?? r.driver}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: 110,
        sortValue: (r) => r.status.toLowerCase(),
        render: (r) => <StatusTag status={r.status} />,
      },
      {
        id: 'mappings',
        header: 'Companies',
        width: 100,
        sortValue: (r) => r.mappingCount,
        render: (r) => (
          <span style={{ color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>
            {r.mappingCount}
          </span>
        ),
      },
      {
        id: 'resources',
        header: 'Resources',
        width: 240,
        sortValue: (r) =>
          r.resources
            .filter((res) => res.enabled && res.assetLayoutId)
            .map((res) => res.resourceLabel.toLowerCase())
            .join(', ') || null,
        render: (r) => {
          const configured = r.resources.filter(
            (res) => res.enabled && res.assetLayoutId,
          );
          if (configured.length === 0) {
            return (
              <Tag tone="warn">
                not configured
              </Tag>
            );
          }
          return (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
              }}
              title={configured
                .map(
                  (res) =>
                    `${res.resourceLabel}: ${res.assetLayoutName ?? '—'} · ${res.fieldMappingCount} mapping${res.fieldMappingCount === 1 ? '' : 's'}`,
                )
                .join('\n')}
            >
              {configured.map((res) => (
                <span
                  key={res.id}
                  style={{
                    color: 'var(--text-2)',
                    fontSize: 12.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <strong>{res.resourceLabel}</strong>
                  <span style={{ color: 'var(--dim)' }}>
                    {' '}
                    · {res.assetLayoutName ?? res.assetLayoutId?.slice(0, 8)} ·{' '}
                    {res.fieldMappingCount} map
                    {res.fieldMappingCount === 1 ? '' : 's'}
                  </span>
                </span>
              ))}
            </div>
          );
        },
      },
      {
        id: 'cron',
        header: 'Schedule',
        width: 180,
        sortValue: (r) => syncCronSortMinutes(r.effectiveSyncCron),
        render: (r) =>
          r.effectiveSyncCron ? (
            <span
              title={r.effectiveSyncCron}
              style={{
                color: 'var(--text-2)',
                fontFamily: describeSyncCron(r.effectiveSyncCron)
                  ? undefined
                  : 'var(--font-mono)',
              }}
            >
              {describeSyncCron(r.effectiveSyncCron) ?? r.effectiveSyncCron}
              {!r.syncCron && (
                <span style={{ color: 'var(--dim)', marginLeft: 6 }}>
                  (default)
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: 'var(--dim)' }}>manual only</span>
          ),
      },
      {
        id: 'lastRun',
        header: 'Last run',
        width: 170,
        sortValue: (r) => (r.lastRunAt ? new Date(r.lastRunAt) : null),
        render: (r) =>
          r.lastRunAt ? (
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
            >
              <RunStatusTag status={r.lastRunStatus} />
              <span style={{ color: 'var(--dim)', fontSize: 12 }}>
                {relative(r.lastRunAt)}
              </span>
            </div>
          ) : (
            <span style={{ color: 'var(--dim)' }}>never</span>
          ),
      },
      {
        id: 'secret',
        header: 'Credentials',
        width: 110,
        sortValue: (r) => (r.hasSecret ? 1 : 0),
        render: (r) =>
          r.hasSecret ? (
            <Tag tone="ok">
              configured
            </Tag>
          ) : (
            <Tag tone="warn">
              missing
            </Tag>
          ),
      },
    ],
    [driverByKey],
  );

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowHref={(r) => `/admin/integrations/${r.id}`}
      empty="No integrations configured yet."
      renderMobileCard={(r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span
              style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}
            >
              {r.name}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--dim)',
              }}
            >
              {driverByKey.get(r.driver)?.label ?? r.driver}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <StatusTag status={r.status} />
            {r.hasSecret ? (
              <Tag tone="ok">
                creds
              </Tag>
            ) : (
              <Tag tone="warn">
                no creds
              </Tag>
            )}
            <Tag tone="outline">{r.mappingCount} mappings</Tag>
          </div>
          <MobileCardRow label="Resources">
            {(() => {
              const configured = r.resources.filter(
                (res) => res.enabled && res.assetLayoutId,
              );
              if (configured.length === 0) return 'not configured';
              return configured
                .map(
                  (res) =>
                    `${res.resourceLabel} → ${res.assetLayoutName ?? 'layout'}`,
                )
                .join(', ');
            })()}
          </MobileCardRow>
          <MobileCardRow label="Last run">
            {r.lastRunAt ? (
              <>
                <RunStatusTag status={r.lastRunStatus} /> {relative(r.lastRunAt)}
              </>
            ) : (
              'never'
            )}
          </MobileCardRow>
          {r.effectiveSyncCron && (
            <MobileCardRow
              label="Schedule"
              mono={!describeSyncCron(r.effectiveSyncCron)}
            >
              {describeSyncCron(r.effectiveSyncCron) ?? r.effectiveSyncCron}
              {!r.syncCron && ' (default)'}
            </MobileCardRow>
          )}
        </div>
      )}
    />
  );
}

function StatusTag({ status }: { status: 'ACTIVE' | 'PAUSED' | 'DISABLED' }) {
  if (status === 'ACTIVE') {
    return (
      <Tag tone="ok">
        active
      </Tag>
    );
  }
  if (status === 'PAUSED') {
    return (
      <Tag tone="warn">
        paused
      </Tag>
    );
  }
  return (
    <Tag tone="default">
      disabled
    </Tag>
  );
}

function RunStatusTag({ status }: { status: string | null }) {
  if (!status) return null;
  if (status === 'succeeded') {
    return (
      <Tag tone="ok">
        ok
      </Tag>
    );
  }
  if (status === 'failed') {
    return (
      <Tag tone="danger">
        failed
      </Tag>
    );
  }
  if (status === 'running' || status === 'queued') {
    return (
      <Tag tone="accent">
        {status}
      </Tag>
    );
  }
  return (
    <Tag tone="default">
      {status}
    </Tag>
  );
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  return `${Math.floor(diff / (30 * day))}mo ago`;
}
