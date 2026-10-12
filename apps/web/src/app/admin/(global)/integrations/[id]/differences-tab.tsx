'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  INTEGRATION_DIFFERENCES_BULK_MAX,
  problemMessage,
  type IntegrationCompanyMappingDto,
  type IntegrationDifferenceBulkMiss,
  type IntegrationDifferenceChoice,
  type IntegrationDifferenceRowDto,
  type IntegrationDifferencesBulkResult,
  type IntegrationDifferencesPage,
  type ResolveIntegrationDifferencesBulkInput,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, DataTable, Field, MobileCardRow, Select, Tag, type DataColumn } from '../../../../../components/ui';
import { FormattedDateTime } from '../../../../../lib/timezone-context';
import { DifferenceActions } from '../../../../../components/integrations/integration-differences';

type Row = IntegrationDifferenceRowDto & { id: string };

/** Ticked rows by id, or every difference matching the company filter. */
type Selection = { kind: 'rows'; ids: Set<string> } | { kind: 'all' };

interface BulkOutcome {
  choice: IntegrationDifferenceChoice;
  applied: number;
  skipped: IntegrationDifferenceBulkMiss[];
  failed: IntegrationDifferenceBulkMiss[];
  /** Set when a request failed outright and the run stopped early. */
  error: string | null;
}

const NO_SELECTION: Selection = { kind: 'rows', ids: new Set() };

function differencesPath(integrationId: string, companyId: string, cursor: string | null): string {
  const params = new URLSearchParams();
  if (companyId) params.set('companyId', companyId);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return `/admin/integrations/${integrationId}/differences${query ? `?${query}` : ''}`;
}

/**
 * Every open difference of this integration: standard fields a person
 * changed that now differ from the source, across all mapped companies,
 * with the same Use source / Keep ours actions as the asset page.
 */
export function DifferencesTab({
  integrationId,
  mappings,
  sourceLabel,
}: {
  integrationId: string;
  mappings: IntegrationCompanyMappingDto[];
  sourceLabel: string;
}) {
  const [companyId, setCompanyId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every reload so a slow page for an old filter is dropped.
  const scopeRef = useRef(0);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [confirming, setConfirming] = useState<IntegrationDifferenceChoice | null>(null);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    const scope = cursor ? scopeRef.current : (scopeRef.current += 1);
    try {
      const res = await apiFetch<IntegrationDifferencesPage>(differencesPath(integrationId, companyId, cursor));
      if (scope !== scopeRef.current) return;
      setError(null);
      if (!res.ok || !res.data) {
        setError(problemMessage(res.problem) ?? 'Could not load the differences.');
        return;
      }
      const page = res.data.items.map((item) => ({ ...item, id: `${item.syncRecordId}:${item.assetFieldId}` }));
      setRows((prev) => (cursor ? [...prev, ...page] : page));
      if (!cursor) {
        setTotal(res.data.total);
        setSelection(NO_SELECTION);
      }
      setNextCursor(res.data.nextCursor);
    } catch {
      if (scope === scopeRef.current) setError('Could not load the differences. Check your connection and try again.');
    } finally {
      if (scope === scopeRef.current) setLoading(false);
    }
  }, [integrationId, companyId]);

  useEffect(() => {
    void (async () => {
      await load(null);
    })();
  }, [load]);

  const companies = [...new Map(mappings.map((m) => [m.companyId, m.companyName ?? m.companyId])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  const selectedCount = selection.kind === 'all' ? total ?? rows.length : selection.ids.size;
  const allLoadedSelected = rows.length > 0 && (selection.kind === 'all' || rows.every((row) => selection.ids.has(row.id)));
  const busy = progress !== null;

  function toggleRow(id: string, checked: boolean) {
    setOutcome(null);
    setSelection((prev) => {
      // Unticking one row of "all matching" falls back to the loaded rows minus that one.
      const ids = new Set(prev.kind === 'all' ? rows.map((row) => row.id) : prev.ids);
      if (checked) ids.add(id);
      else ids.delete(id);
      return { kind: 'rows', ids };
    });
  }

  function toggleLoaded(checked: boolean) {
    setOutcome(null);
    setSelection(checked ? { kind: 'rows', ids: new Set(rows.map((row) => row.id)) } : NO_SELECTION);
  }

  async function postBulk(body: ResolveIntegrationDifferencesBulkInput): Promise<IntegrationDifferencesBulkResult> {
    const res = await apiFetch<IntegrationDifferencesBulkResult>(`/admin/integrations/${integrationId}/differences/resolve-bulk`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.data) throw new Error(problemMessage(res.problem) ?? 'Could not resolve the differences.');
    return res.data;
  }

  /** Sends the selection in batches of the server cap, with progress, then reloads. */
  async function runBulk(choice: IntegrationDifferenceChoice) {
    setConfirming(null);
    const result: BulkOutcome = { choice, applied: 0, skipped: [], failed: [], error: null };
    const add = (batch: IntegrationDifferencesBulkResult) => {
      result.applied += batch.applied;
      result.skipped.push(...batch.skipped);
      result.failed.push(...batch.failed);
    };
    const of = selectedCount;
    let done = 0;
    setProgress({ done, of });
    try {
      if (selection.kind === 'all') {
        let cursor: string | undefined;
        do {
          const batch = await postBulk({ choice, filter: { ...(companyId ? { companyId } : {}), ...(cursor ? { cursor } : {}) } });
          add(batch);
          done += batch.applied + batch.skipped.length + batch.failed.length;
          setProgress({ done: Math.min(done, of), of });
          cursor = batch.nextCursor ?? undefined;
        } while (cursor);
      } else {
        const items = rows
          .filter((row) => selection.ids.has(row.id))
          .map((row) => ({ syncRecordId: row.syncRecordId, assetFieldId: row.assetFieldId }));
        for (let start = 0; start < items.length; start += INTEGRATION_DIFFERENCES_BULK_MAX) {
          const chunk = items.slice(start, start + INTEGRATION_DIFFERENCES_BULK_MAX);
          add(await postBulk({ choice, items: chunk }));
          done += chunk.length;
          setProgress({ done, of });
        }
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : 'Could not resolve the differences.';
    }
    setProgress(null);
    setOutcome(result);
    setLoading(true);
    await load(null);
  }

  const actions = (row: Row) => (
    <DifferenceActions
      companyId={row.companyId}
      assetId={row.assetId}
      difference={row}
      sourceLabel={sourceLabel}
      onResolved={() => void load(null)}
    />
  );
  const assetLink = (row: Row) => (
    <Link href={`/admin/companies/${row.companyId}/assets/${row.assetId}`}>{row.assetName}</Link>
  );
  const rowCheckbox = (row: Row) => (
    <input
      type="checkbox"
      aria-label={`Select ${row.fieldLabel} on ${row.assetName}`}
      checked={selection.kind === 'all' || selection.ids.has(row.id)}
      disabled={busy}
      onChange={(e) => toggleRow(row.id, e.target.checked)}
    />
  );
  const columns: DataColumn<Row>[] = [
    {
      id: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all loaded differences"
          checked={allLoadedSelected}
          disabled={busy || rows.length === 0}
          onChange={(e) => toggleLoaded(e.target.checked)}
        />
      ),
      width: 36,
      render: rowCheckbox,
    },
    { id: 'asset', header: 'Asset', width: 200, render: assetLink },
    { id: 'company', header: 'Company', width: 160, render: (row) => row.companyName },
    { id: 'field', header: 'Field', width: 140, render: (row) => row.fieldLabel },
    { id: 'local', header: 'Weavestream value', width: 180, render: (row) => row.localValue ?? 'empty' },
    { id: 'source', header: `${sourceLabel} value`, width: 180, render: (row) => row.sourceValue ?? 'empty' },
    {
      id: 'detected',
      header: 'Detected',
      width: 150,
      render: (row) => <FormattedDateTime value={row.detectedAt} />,
    },
    { id: 'actions', header: '', width: 260, render: actions },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>Differences</h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          Fields someone changed in Weavestream that now differ from {sourceLabel}. Syncs leave them alone.
          Use the {sourceLabel} value to make the field follow {sourceLabel} again, or keep ours to stop
          flagging it until the {sourceLabel} value changes.
        </p>
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <Field label="Company" htmlFor="differences-company" style={{ flex: '0 1 260px', minWidth: 0 }}>
          <Select
            id="differences-company"
            value={companyId}
            onChange={(e) => {
              setLoading(true);
              setCompanyId(e.target.value);
            }}
          >
            <option value="">All companies</option>
            {companies.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        {total !== null && <Tag tone={total > 0 ? 'warn' : 'ok'}>{`${total} open`}</Tag>}
      </div>
      {error && <Tag tone="danger">{error}</Tag>}
      {rows.length > 0 && (
        <BulkBar
          sourceLabel={sourceLabel}
          loadedCount={rows.length}
          total={total}
          selection={selection}
          selectedCount={selectedCount}
          allLoadedSelected={allLoadedSelected}
          busy={busy}
          onToggleLoaded={toggleLoaded}
          onSelectAllMatching={() => {
            setOutcome(null);
            setSelection({ kind: 'all' });
          }}
          onClear={() => setSelection(NO_SELECTION)}
          onChoose={(choice) => {
            setOutcome(null);
            setConfirming(choice);
          }}
        />
      )}
      {confirming && (
        <div
          role="alertdialog"
          aria-label="Confirm bulk action"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 10, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface)' }}
        >
          <span style={{ flex: '1 1 240px', fontSize: 12.5 }}>
            {confirming === 'source'
              ? `Write the ${sourceLabel} value into ${countLabel(selectedCount)}? Those fields follow ${sourceLabel} again.`
              : `Keep the Weavestream value for ${countLabel(selectedCount)}? They stop being flagged until the ${sourceLabel} value changes.`}
          </span>
          <Btn kind="primary" onClick={() => void runBulk(confirming)}>Confirm</Btn>
          <Btn onClick={() => setConfirming(null)}>Cancel</Btn>
        </div>
      )}
      {progress && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
          <span>{`Resolving ${progress.done} of ${progress.of}...`}</span>
          <progress value={progress.done} max={Math.max(progress.of, 1)} style={{ width: '100%', maxWidth: 360 }} />
        </div>
      )}
      {outcome && <BulkSummary outcome={outcome} sourceLabel={sourceLabel} onDismiss={() => setOutcome(null)} />}
      <DataTable
        columns={columns}
        rows={rows}
        empty={loading ? 'Loading differences...' : 'No open differences.'}
        disableSort
        renderMobileCard={(row) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minHeight: 32 }}>
              {rowCheckbox(row)}
              Select
            </label>
            <MobileCardRow label="Asset">{assetLink(row)}</MobileCardRow>
            <MobileCardRow label="Company">{row.companyName}</MobileCardRow>
            <MobileCardRow label="Field">{row.fieldLabel}</MobileCardRow>
            <MobileCardRow label="Weavestream">{row.localValue ?? 'empty'}</MobileCardRow>
            <MobileCardRow label={sourceLabel}>{row.sourceValue ?? 'empty'}</MobileCardRow>
            <div style={{ paddingTop: 4 }}>{actions(row)}</div>
          </div>
        )}
      />
      {nextCursor && (
        <div>
          <Btn
            onClick={() => {
              setLoading(true);
              void load(nextCursor);
            }}
            loading={loading}
          >
            Load more
          </Btn>
        </div>
      )}
    </div>
  );
}

function countLabel(count: number): string {
  return count === 1 ? '1 difference' : `${count} differences`;
}

/** Selection controls and the two bulk actions; wraps on narrow screens. */
function BulkBar({
  sourceLabel,
  loadedCount,
  total,
  selection,
  selectedCount,
  allLoadedSelected,
  busy,
  onToggleLoaded,
  onSelectAllMatching,
  onClear,
  onChoose,
}: {
  sourceLabel: string;
  loadedCount: number;
  total: number | null;
  selection: Selection;
  selectedCount: number;
  allLoadedSelected: boolean;
  busy: boolean;
  onToggleLoaded: (checked: boolean) => void;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onChoose: (choice: IntegrationDifferenceChoice) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32 }}>
        <input type="checkbox" checked={allLoadedSelected} disabled={busy} onChange={(e) => onToggleLoaded(e.target.checked)} />
        {`Select loaded (${loadedCount})`}
      </label>
      {allLoadedSelected && selection.kind === 'rows' && total !== null && total > loadedCount && (
        <Btn onClick={onSelectAllMatching} disabled={busy}>{`Select all ${total} matching`}</Btn>
      )}
      {selectedCount > 0 && (
        <>
          <span style={{ color: 'var(--muted)' }}>
            {selection.kind === 'all' ? `All ${selectedCount} matching selected` : `${selectedCount} selected`}
          </span>
          <Btn kind="primary" disabled={busy} onClick={() => onChoose('source')}>{`Use ${sourceLabel} value`}</Btn>
          <Btn disabled={busy} onClick={() => onChoose('local')}>Keep ours</Btn>
          <Btn disabled={busy} onClick={onClear}>Clear</Btn>
        </>
      )}
    </div>
  );
}

/** What the bulk run did: counts, then each skipped or failed difference with its reason. */
function BulkSummary({ outcome, sourceLabel, onDismiss }: { outcome: BulkOutcome; sourceLabel: string; onDismiss: () => void }) {
  const misses = [
    ...outcome.skipped.map((miss) => ({ ...miss, kind: 'Skipped' })),
    ...outcome.failed.map((miss) => ({ ...miss, kind: 'Failed' })),
  ];
  const verb = outcome.choice === 'source' ? `Used the ${sourceLabel} value for` : 'Kept ours for';
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: '1px solid var(--line)', borderRadius: 6, fontSize: 12.5 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: '1 1 240px' }}>
          {`${verb} ${countLabel(outcome.applied)}. Skipped ${outcome.skipped.length}, failed ${outcome.failed.length}.`}
        </span>
        <Btn onClick={onDismiss}>Dismiss</Btn>
      </div>
      {outcome.error && <Tag tone="danger">{`Stopped early: ${outcome.error}`}</Tag>}
      {misses.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 200, overflowY: 'auto', overflowWrap: 'anywhere' }}>
          {misses.map((miss) => (
            <li key={`${miss.kind}:${miss.syncRecordId}:${miss.assetFieldId}`}>
              {`${miss.kind}: ${miss.assetName ?? 'Unknown asset'}: ${miss.reason}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
