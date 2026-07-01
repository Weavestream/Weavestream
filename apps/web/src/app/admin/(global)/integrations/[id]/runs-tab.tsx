'use client';

import { useEffect, useState } from 'react';
import type {
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationSyncRunCompanyResultDto,
  IntegrationSyncRunDto,
  SyncRunConflict,
  SyncRunTotals,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Dialog, Icon, Tag } from '../../../../../components/ui';

/**
 * Phase 11 — sync run history.
 *
 * Lists recent runs for the integration with totals, status, and a
 * "view details" affordance that opens a per-run drawer with the
 * per-mapping breakdown + conflict log. Read-only.
 */
export function RunsTab({
  integration,
  runs,
  mappings,
}: {
  integration: IntegrationDto;
  runs: IntegrationSyncRunDto[];
  mappings: IntegrationCompanyMappingDto[];
}) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
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
          Latest sync runs across every mapping in this integration. The 50
          most recent runs are kept.
        </p>
      </header>

      {runs.length === 0 ? (
        <div style={emptyState}>
          No syncs yet. Trigger a manual run from the Credentials &amp; schedule
          tab to populate this history.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {runs.map((r, idx) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpenRunId(r.id)}
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 100px 100px 1fr 16px',
                gap: 12,
                width: '100%',
                padding: '10px 14px',
                background: 'transparent',
                border: 'none',
                borderTop: idx === 0 ? 'none' : '1px solid var(--line)',
                cursor: 'pointer',
                textAlign: 'left',
                alignItems: 'center',
                color: 'var(--text)',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {formatDateTime(r.startedAt ?? r.createdAt)}
              </span>
              <RunStatusTag status={r.status} />
              <Tag tone="default">{r.kind}</Tag>
              <RunTotalsSummary totals={r.totals as SyncRunTotals | null} dryRun={r.dryRun} />
              <Icon.chevron size={11} style={{ color: 'var(--dim)' }} />
            </button>
          ))}
        </div>
      )}

      {openRunId && (
        <RunDetailDialog
          integrationId={integration.id}
          runId={openRunId}
          mappings={mappings}
          resourceLabelByKey={resourceLabelByKey(integration)}
          onClose={() => setOpenRunId(null)}
        />
      )}
    </div>
  );
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
  onClose,
}: {
  integrationId: string;
  runId: string;
  mappings: IntegrationCompanyMappingDto[];
  resourceLabelByKey: Map<string, string>;
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
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 6,
                fontSize: 12.5,
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span>started: {formatDateTime(run.startedAt ?? run.createdAt)}</span>
              <span>finished: {formatDateTime(run.finishedAt)}</span>
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
            <div style={{ marginTop: 10 }}>
              <RunTotalsBreakdown totals={run.totals as SyncRunTotals | null} />
            </div>
            <ResourceTotalsBreakdown
              totals={run.totals as SyncRunTotals | null}
              resourceLabelByKey={resourceLabelByKey}
            />
            {run.error && (
              <Tag tone="danger" style={{ marginTop: 8 }}>
                {run.error}
              </Tag>
            )}
          </section>

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
            <code style={{ fontSize: 11.5 }}>{c.externalId}</code> — {c.message}
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

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Assemble from parts with our OWN separators instead of letting
  // `toLocaleString` join them. With `month: 'short'`, newer CLDR (the
  // browser's ICU) inserts an " at " connector — "Jul 01, 2026 at 08:00
  // AM" — while Node's ICU still uses ", ". As a client component this is
  // rendered on both the server and the client, so that divergence is a
  // hydration mismatch. Reading the part values (which agree across ICU
  // versions) and joining them ourselves makes the output deterministic.
  // Locale is pinned for the same reason (month name / AM-PM must not
  // follow each runtime's default).
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const v = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${v('month')} ${v('day')}, ${v('year')}, ${v('hour')}:${v('minute')} ${v('dayPeriod')}`;
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

const emptyState: React.CSSProperties = {
  padding: 32,
  border: '1px dashed var(--line-2)',
  borderRadius: 8,
  color: 'var(--muted)',
  textAlign: 'center',
  fontSize: 13,
};
