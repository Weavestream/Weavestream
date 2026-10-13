'use client';

import { useEffect, useState } from 'react';
import type {
  CloudflareDomainSyncResult,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationSyncRunCompanyResultDto,
  IntegrationSyncRunDto,
  SyncRunConflict,
  SyncRunTotals,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  DataTable,
  Dialog,
  Icon,
  MobileCardRow,
  Tag,
  type DataColumn,
} from '../../../../../components/ui';
import { FormattedDateTime } from '../../../../../lib/timezone-context';
import { domainSyncSummary } from './cloudflare/domains-sync-tab';

/**
 * What the runs record. `records`: asset-import syncs, whose totals are
 * {@link SyncRunTotals} with a per-mapping breakdown. `domains`: Cloudflare
 * registrar syncs, whose totals are a {@link CloudflareDomainSyncResult} and
 * which have no mode and no per-company results.
 */
export type RunsTabVariant = 'records' | 'domains';

/**
 * Phase 11 — sync run history.
 *
 * Lists recent runs for the integration with totals, status, and a
 * "view details" affordance that opens a per-run drawer with the
 * per-mapping breakdown + conflict log. Read-only. Uses the global
 * table standard, so phones get one card per run.
 */
export function RunsTab({
  integration,
  runs,
  mappings,
  variant = 'records',
}: {
  integration: IntegrationDto;
  runs: IntegrationSyncRunDto[];
  mappings: IntegrationCompanyMappingDto[];
  variant?: RunsTabVariant;
}) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const domains = variant === 'domains';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <h3 style={sectionHeader}>Run history</h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          {domains
            ? 'Manual and scheduled domain syncs, newest first. The 50 most recent runs are shown.'
            : 'Latest sync runs across every mapping in this integration. The 50 most recent runs are kept.'}
        </p>
      </header>

      <DataTable
        columns={runColumns(variant, setOpenRunId)}
        rows={runs}
        onRowClick={(r) => setOpenRunId(r.id)}
        defaultSort={{ columnId: 'started', direction: 'desc' }}
        layout="fixed"
        empty={
          domains
            ? 'No domain syncs yet. Select “Sync domains now” on the Domains tab, or wait for the schedule.'
            : 'No syncs yet. Trigger a manual run from the Credentials & schedule tab to populate this history.'
        }
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <RunStatusTag status={r.status} />
              <Tag tone="default">{r.kind}</Tag>
              {!domains && <RunModeTag mode={r.mode} />}
              {r.dryRun && <Tag tone="info">dry run</Tag>}
            </div>
            <MobileCardRow label="Started" mono>
              <FormattedDateTime value={r.startedAt ?? r.createdAt} />
            </MobileCardRow>
            <MobileCardRow label="Result">
              <RunRowSummary run={r} variant={variant} wrap />
            </MobileCardRow>
          </div>
        )}
      />

      {openRunId && (
        <RunDetailDialog
          integrationId={integration.id}
          runId={openRunId}
          mappings={mappings}
          resourceLabelByKey={resourceLabelByKey(integration)}
          variant={variant}
          onClose={() => setOpenRunId(null)}
        />
      )}
    </div>
  );
}

/**
 * Desktop columns. The result column declares no width so it takes the
 * slack under `layout="fixed"`; the last column is a real button, so the
 * run details stay reachable from the keyboard (a row click is mouse-only).
 */
function runColumns(
  variant: RunsTabVariant,
  open: (runId: string) => void,
): DataColumn<IntegrationSyncRunDto>[] {
  const cols: DataColumn<IntegrationSyncRunDto>[] = [
    {
      id: 'started',
      header: 'Started',
      width: 130,
      mono: true,
      render: (r) => <FormattedDateTime value={r.startedAt ?? r.createdAt} />,
      sortValue: (r) => r.startedAt ?? r.createdAt,
    },
    {
      id: 'status',
      header: 'Status',
      width: 104,
      render: (r) => <RunStatusTag status={r.status} />,
      sortValue: (r) => r.status,
    },
    {
      // Mode shares this column so the result keeps its width when a
      // side panel narrows the page.
      id: 'kind',
      header: 'Kind',
      width: 116,
      render: (r) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <Tag tone="default">{r.kind}</Tag>
          {variant === 'records' && <RunModeTag mode={r.mode} />}
        </div>
      ),
      sortValue: (r) => r.kind,
    },
  ];
  cols.push(
    {
      id: 'result',
      header: 'Result',
      render: (r) => <RunRowSummary run={r} variant={variant} />,
    },
    {
      id: 'open',
      header: '',
      width: 44,
      align: 'right',
      render: (r) => (
        <button
          type="button"
          aria-label="View run details"
          onClick={() => open(r.id)}
          style={openButton}
        >
          <Icon.chevron size={11} />
        </button>
      ),
    },
  );
  return cols;
}

function RunModeTag({ mode }: { mode: IntegrationSyncRunDto['mode'] }) {
  return <Tag tone={mode === 'full' ? 'accent' : 'default'}>{mode}</Tag>;
}

function resourceLabelByKey(integration: IntegrationDto): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of integration.resources) m.set(r.resourceKey, r.resourceLabel);
  return m;
}

function RunDetailDialog({
  integrationId,
  runId,
  mappings,
  resourceLabelByKey,
  variant,
  onClose,
}: {
  integrationId: string;
  runId: string;
  mappings: IntegrationCompanyMappingDto[];
  resourceLabelByKey: Map<string, string>;
  variant: RunsTabVariant;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<{
    run: IntegrationSyncRunDto;
    companyResults: IntegrationSyncRunCompanyResultDto[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{
        run: IntegrationSyncRunDto;
        companyResults: IntegrationSyncRunCompanyResultDto[];
      }>(`/admin/integrations/${integrationId}/runs/${runId}`);
      if (cancelled) return;
      setLoading(false);
      if (res.ok && res.data) setDetail(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [integrationId, runId]);

  const run = detail?.run ?? null;
  const companyResults = detail?.companyResults ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          Run details
          {run && <RunStatusTag status={run.status} />}
          {run?.dryRun && <Tag tone="info">dry run</Tag>}
        </span>
      }
      width={760}
      footer={
        <Btn kind="ghost" onClick={onClose}>
          Close
        </Btn>
      }
    >
      {loading || !run ? (
        <Tag tone="default">Loading…</Tag>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section>
            <h4 style={subHeader}>Summary</h4>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 6,
                fontSize: 12.5,
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span>started: <FormattedDateTime value={run.startedAt ?? run.createdAt} /></span>
              <span>finished: <FormattedDateTime value={run.finishedAt} /></span>
              <span>kind: {run.kind}</span>
              <span title={run.triggeredByUser?.email ?? run.triggeredBy ?? undefined}>
                triggered by:{' '}
                {run.triggeredByUser
                  ? run.triggeredByUser.name
                  : run.triggeredBy
                    ? run.triggeredBy.slice(0, 8)
                    : 'system'}
              </span>
            </div>
            {variant === 'domains' ? (
              run.totals && (
                <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--muted)' }}>
                  {domainSyncSummary(run.totals as CloudflareDomainSyncResult)}.
                </p>
              )
            ) : (
              <>
                <div style={{ marginTop: 10 }}>
                  <RunTotalsBreakdown totals={run.totals as SyncRunTotals | null} />
                </div>
                <ResourceTotalsBreakdown
                  totals={run.totals as SyncRunTotals | null}
                  resourceLabelByKey={resourceLabelByKey}
                />
              </>
            )}
            {run.error && (
              // Wraps, unlike a Tag: a run error can be a sentence or two.
              <p style={runErrorText}>{run.error}</p>
            )}
          </section>

          {variant === 'records' && (
            <section>
              <h4 style={subHeader}>Per-company results</h4>
              {companyResults.length === 0 ? (
                <Tag tone="default">No company results recorded.</Tag>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {companyResults.map((r) => {
                    const m = mappings.find(
                      (x) => x.id === r.integrationCompanyMappingId,
                    );
                    return (
                      <div
                        key={r.id}
                        style={{
                          border: '1px solid var(--line)',
                          borderRadius: 6,
                          padding: 10,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 8,
                            marginBottom: 6,
                          }}
                        >
                          <strong style={{ fontSize: 13 }}>
                            {r.companyName ?? r.companyId.slice(0, 8)}
                          </strong>
                          {m && (
                            <Tag tone="default">
                              {m.externalOrgName ?? m.externalOrgId}
                            </Tag>
                          )}
                          <RunStatusTag status={r.status} />
                        </div>
                        <RunTotalsBreakdown totals={r.totals as SyncRunTotals | null} />
                        <ResourceTotalsBreakdown
                          totals={r.totals as SyncRunTotals | null}
                          resourceLabelByKey={resourceLabelByKey}
                        />
                        {r.error && (
                          <Tag tone="danger" style={{ marginTop: 6 }}>
                            {r.error}
                          </Tag>
                        )}
                        {Array.isArray(r.conflicts) && r.conflicts.length > 0 && (
                          <ConflictList conflicts={r.conflicts as SyncRunConflict[]} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ConflictList({ conflicts }: { conflicts: SyncRunConflict[] }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 4,
        }}
      >
        Conflicts ({conflicts.length})
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 16,
          fontSize: 12.5,
          color: 'var(--text-2)',
        }}
      >
        {conflicts.map((c, i) => (
          <li key={i} style={{ marginBottom: 2 }}>
            <Tag tone={conflictTone(c.kind)}>{c.kind.replace('_', ' ')}</Tag>{' '}
            {c.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function conflictTone(
  kind: SyncRunConflict['kind'],
): 'warn' | 'danger' | 'info' {
  switch (kind) {
    case 'ambiguous_match':
      return 'warn';
    case 'manual_skip':
      return 'info';
    case 'secret_blocked':
      return 'warn';
    default:
      return 'danger';
  }
}

function RunStatusTag({ status }: { status: string }) {
  const tone = (() => {
    switch (status) {
      case 'succeeded':
        return 'ok' as const;
      case 'running':
        return 'info' as const;
      case 'failed':
        return 'danger' as const;
      case 'cancelled':
        return 'warn' as const;
      default:
        return 'default' as const;
    }
  })();
  return (
    <Tag tone={tone}>
      {status}
    </Tag>
  );
}

/**
 * The row's one-line outcome. A run that failed before recording any totals
 * shows its error here, so the reason is visible without opening the run.
 */
function RunRowSummary({
  run,
  variant,
  wrap = false,
}: {
  run: IntegrationSyncRunDto;
  variant: RunsTabVariant;
  /** Wrap to a few lines instead of one, for the mobile card. */
  wrap?: boolean;
}) {
  const text = wrap ? wrappedSummaryText : rowSummaryText;
  if (run.status === 'failed' && run.error && !run.totals) {
    return (
      <span title={run.error} style={{ ...text, color: 'var(--danger)' }}>
        {run.error}
      </span>
    );
  }
  if (variant === 'domains') {
    return (
      <span style={{ ...text, color: run.totals ? 'var(--muted)' : 'var(--dim)' }}>
        {run.totals ? domainSyncSummary(run.totals as CloudflareDomainSyncResult) : 'no totals'}
      </span>
    );
  }
  return <RunTotalsSummary totals={run.totals as SyncRunTotals | null} dryRun={run.dryRun} />;
}

function RunTotalsSummary({
  totals,
  dryRun,
}: {
  totals: SyncRunTotals | null;
  dryRun: boolean;
}) {
  if (!totals)
    return (
      <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
        {dryRun ? 'dry run pending' : 'no totals'}
      </span>
    );
  return (
    <span
      style={{
        fontSize: 11.5,
        fontFamily: 'var(--font-mono)',
        color: 'var(--muted)',
      }}
    >
      {totals.fetched} fetched · {totals.created} created · {totals.updated} updated · {totals.unchanged} unchanged
      {totals.skippedAmbiguous > 0
        ? ` · ${totals.skippedAmbiguous} ambiguous`
        : ''}
      {totals.skippedArchived > 0
        ? ` · ${totals.skippedArchived} archived skipped`
        : ''}
      {totals.stale > 0 ? ` · ${totals.stale} stale` : ''}
      {totals.restored > 0 ? ` · ${totals.restored} restored` : ''}
      {totals.blocked > 0 ? ` · ${totals.blocked} blocked` : ''}
      {totals.secretBlocked > 0 ? ` · ${totals.secretBlocked} secret blocked` : ''}
      {totals.missingDependency > 0 ? ` · ${totals.missingDependency} missing dependency` : ''}
      {totals.errors > 0 ? ` · ${totals.errors} errors` : ''}
      {dryRun ? ' · dry-run' : ''}
    </span>
  );
}

function ResourceTotalsBreakdown({
  totals,
  resourceLabelByKey,
}: {
  totals: SyncRunTotals | null;
  resourceLabelByKey: Map<string, string>;
}) {
  if (!totals?.byResource) return null;
  const entries = Object.entries(totals.byResource).filter(([, v]) => {
    return (
      v &&
      (v.fetched > 0 ||
        v.created > 0 ||
        v.updated > 0 ||
        v.unchanged > 0 ||
        v.claimed > 0 ||
        v.archived > 0 ||
        v.skippedAmbiguous > 0 ||
        v.skippedManual > 0 ||
        v.skippedArchived > 0 ||
        v.stale > 0 ||
        v.restored > 0 ||
        v.blocked > 0 ||
        v.secretBlocked > 0 ||
        v.missingDependency > 0 ||
        v.errors > 0)
    );
  });
  if (entries.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 10,
        background: 'var(--panel-2)',
        border: '1px solid var(--line-2)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}
      >
        Per resource
      </div>
      {entries.map(([key, sub]) => (
        <div
          key={key}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 12.5 }}>
              {resourceLabelByKey.get(key) ?? key}
            </strong>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {key}
            </span>
          </div>
          <RunTotalsBreakdown totals={sub as SyncRunTotals | null} />
        </div>
      ))}
    </div>
  );
}

function RunTotalsBreakdown({ totals }: { totals: SyncRunTotals | null }) {
  if (!totals) return <Tag tone="default">no totals</Tag>;
  type Cell = {
    label: string;
    value: number;
    tone?: 'ok' | 'warn' | 'danger' | 'info';
  };
  const cells: Cell[] = (
    [
      { label: 'fetched', value: totals.fetched },
      { label: 'created', value: totals.created, tone: 'ok' },
      { label: 'updated', value: totals.updated, tone: 'info' },
      { label: 'unchanged', value: totals.unchanged },
      { label: 'claimed', value: totals.claimed, tone: 'info' },
      { label: 'archived', value: totals.archived, tone: 'warn' },
      { label: 'ambiguous', value: totals.skippedAmbiguous, tone: 'warn' },
      { label: 'manual skip', value: totals.skippedManual, tone: 'warn' },
      { label: 'archived skip', value: totals.skippedArchived, tone: 'warn' },
      { label: 'stale', value: totals.stale, tone: 'warn' },
      { label: 'restored', value: totals.restored, tone: 'ok' },
      { label: 'blocked', value: totals.blocked, tone: 'danger' },
      { label: 'secret blocked', value: totals.secretBlocked, tone: 'warn' },
      { label: 'missing dependency', value: totals.missingDependency, tone: 'warn' },
      { label: 'errors', value: totals.errors, tone: 'danger' },
    ] satisfies Cell[]
  ).filter((c) => c.value > 0);
  if (cells.length === 0) return <Tag tone="default">no records</Tag>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {cells.map((c) => (
        <Tag key={c.label} tone={c.tone ?? 'default'}>
          {c.value} {c.label}
        </Tag>
      ))}
    </div>
  );
}

const sectionHeader: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: -0.2,
};

const subHeader: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
};

const rowSummaryText: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** Three lines at most: a card is a preview, the run details hold the rest. */
const wrappedSummaryText: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  fontSize: 12,
  overflowWrap: 'anywhere',
  lineHeight: 1.45,
};

const openButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  color: 'var(--dim)',
  cursor: 'pointer',
};

const runErrorText: React.CSSProperties = {
  margin: '8px 0 0',
  fontSize: 12.5,
  color: 'var(--danger)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  lineHeight: 1.5,
};
