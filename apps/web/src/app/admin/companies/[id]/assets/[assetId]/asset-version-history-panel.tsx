'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { problemMessage } from '@weavestream/shared';
import type {
  AssetVersionDetail,
  AssetVersionFieldMeta,
  AssetVersionList,
  AssetVersionSummary,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../../lib/api';
import { FormattedShortDateTime } from '../../../../../../lib/timezone-context';
import { formatVersionValue } from '../../../../../../lib/asset-version-format';
import { Panel, useToast } from '../../../../../../components/ui';

/** Versions fetched per page; the server caps at 100. */
const PAGE_SIZE = 20;

/** One row of a version: the asset name or one layout field. */
type Row = {
  /** `name` or a field id: exactly what the restore endpoint accepts. */
  key: string;
  label: string;
  field: Pick<AssetVersionFieldMeta, 'fieldType' | 'options'>;
  value: unknown;
  previous: unknown;
  changed: boolean;
  /** The value was scrubbed from this version by an operator. */
  redacted: boolean;
};

const NAME_FIELD = { fieldType: 'TEXT', options: {} } as const;

function rowsFor(detail: AssetVersionDetail, fields: AssetVersionFieldMeta[]): Row[] {
  const rows: Row[] = [
    {
      key: 'name',
      label: 'Name',
      field: NAME_FIELD,
      value: detail.name,
      previous: detail.previous?.name,
      changed: detail.changedFields.includes('name'),
      redacted: false,
    },
  ];
  for (const f of fields) {
    const value = detail.values[f.id];
    const changed = detail.changedFields.includes(f.id);
    const redacted = detail.redactedFields.includes(f.id);
    // A field that was never set and did not change here has nothing to show.
    if (value === undefined && !changed && !redacted) continue;
    rows.push({
      key: f.id,
      label: f.name,
      field: f,
      value,
      previous: detail.previous?.values[f.id],
      changed,
      redacted,
    });
  }
  return rows;
}

type DetailState = AssetVersionDetail | 'loading' | 'error';

/**
 * Version history of one asset. Nothing is fetched until the panel is
 * opened: the list (summaries only) loads on open and on "Load more", and a
 * version's captured values load when its changes are shown (the latest
 * opens by itself). Restore buttons render only for `canManage`.
 */
export function AssetVersionHistoryPanel({
  companyId,
  assetId,
  canManage,
}: {
  companyId: string;
  assetId: string;
  /** Can edit and the asset is not archived: gates every restore button. */
  canManage: boolean;
}) {
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<AssetVersionFieldMeta[]>([]);
  const [items, setItems] = useState<AssetVersionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const [shown, setShown] = useState<Record<number, boolean>>({});

  const base = `/companies/${companyId}/assets/${assetId}/versions`;

  const loadDetail = useCallback(
    async (version: number) => {
      setDetails((d) => ({ ...d, [version]: 'loading' }));
      const res = await apiFetch<AssetVersionDetail>(`${base}/${version}`);
      setDetails((d) => ({ ...d, [version]: res.ok && res.data ? res.data : 'error' }));
    },
    [base],
  );

  const loadPage = useCallback(
    async (cursor: number | null) => {
      setLoading(true);
      setError(null);
      const qs = `?limit=${PAGE_SIZE}${cursor !== null ? `&cursor=${cursor}` : ''}`;
      const res = await apiFetch<AssetVersionList>(`${base}${qs}`);
      setLoading(false);
      if (!res.ok || !res.data) {
        setError(problemMessage(res.problem) ?? 'Could not load version history');
        return;
      }
      const page = res.data;
      setFields(page.fields);
      setItems((prev) => (cursor === null ? page.items : [...prev, ...page.items]));
      setNextCursor(page.nextCursor);
      // The newest version opens by itself, as before.
      const first = cursor === null ? page.items[0] : undefined;
      if (first) {
        setShown((s) => ({ ...s, [first.version]: true }));
        void loadDetail(first.version);
      }
    },
    [base, loadDetail],
  );

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && items.length === 0 && !loading) void loadPage(null);
  }

  function toggleVersion(version: number) {
    const now = !shown[version];
    setShown((s) => ({ ...s, [version]: now }));
    if (now && details[version] === undefined) void loadDetail(version);
  }

  async function restore(version: number, row?: Row) {
    const what = row ? `the ${row.label}` : `version #${version}`;
    const message = row
      ? `Restore the ${row.label} from version #${version} as a new version on top of history?\n\nOnly the ${row.label} changes; every other field keeps its current value. This is forward-only — a new version will be appended and the current one is kept in history.`
      : `Restore version #${version} as a new version on top of history?\n\nThis is forward-only — a new version will be appended and the current one is kept in history. The integration link (external ID and source) is never changed by a restore.`;
    if (!window.confirm(message)) return;
    setBusy(version);
    const res = await apiFetch(
      `${base}/${version}/restore`,
      row
        ? { method: 'POST', body: JSON.stringify({ fields: [row.key] }) }
        : { method: 'POST' },
    );
    setBusy(null);
    if (!res.ok) {
      toast.push(problemMessage(res.problem) ?? 'Restore failed', 'danger');
      return;
    }
    toast.push(`Restored ${what} from v${version}`, 'ok');
    // Start over so the new top version shows; the page itself refreshes too.
    setItems([]);
    setDetails({});
    setShown({});
    setNextCursor(null);
    void loadPage(null);
    startTransition(() => router.refresh());
  }

  const fieldName = (id: string): string =>
    id === 'name' ? 'name' : id === 'externalId' ? 'external ID' : id === 'externalSource' ? 'external source' : (fields.find((f) => f.id === id)?.name ?? 'a field');

  return (
    <Panel
      title="Version history"
      actions={<TextAction onClick={toggleOpen}>{open ? 'Hide' : 'Show version history'}</TextAction>}
    >
      {!open ? (
        <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
          Every change to this asset is kept. Open to see who changed what and restore earlier values.
        </div>
      ) : error ? (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 12.5 }}>
          {error}{' '}
          <TextAction onClick={() => void loadPage(items.length > 0 ? nextCursor : null)}>Retry</TextAction>
        </div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
          {loading
            ? 'Loading…'
            : 'No versions yet. The first change to this asset starts its history.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {items.map((summary) => (
            <VersionItem
              key={summary.version}
              summary={summary}
              detail={details[summary.version]}
              expanded={shown[summary.version] === true}
              fields={fields}
              fieldName={fieldName}
              canManage={canManage}
              busy={busy === summary.version}
              onToggle={() => toggleVersion(summary.version)}
              onRestore={(row) => void restore(summary.version, row)}
            />
          ))}
          {nextCursor !== null && (
            <div>
              <TextAction disabled={loading} onClick={() => void loadPage(nextCursor)}>
                {loading ? 'Loading…' : 'Load older versions'}
              </TextAction>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function VersionItem({
  summary,
  detail,
  expanded,
  fields,
  fieldName,
  canManage,
  busy,
  onToggle,
  onRestore,
}: {
  summary: AssetVersionSummary;
  detail: DetailState | undefined;
  expanded: boolean;
  fields: AssetVersionFieldMeta[];
  fieldName: (id: string) => string;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: (row?: Row) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const author = summary.changedByName ?? 'System';
  const loaded = typeof detail === 'object' ? detail : null;
  const rows = loaded ? rowsFor(loaded, fields) : [];
  const changedRows = rows.filter((r) => r.changed);
  const unchangedCount = rows.length - changedRows.length;
  // A version with nothing marked changed (the baseline) shows everything.
  const visible = showAll || changedRows.length === 0 ? rows : changedRows;
  const changedNames = summary.changedFields.map(fieldName);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}
      aria-label={`Version ${summary.version}`}
      role="group"
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          columnGap: 8,
          rowGap: 2,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text)',
              fontWeight: 600,
            }}
          >
            v{summary.version}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
            {author}
          </span>
          {summary.redacted && <span style={{ fontSize: 10.5, color: 'var(--warn)' }}>redacted</span>}
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
            whiteSpace: 'nowrap',
          }}
        >
          <FormattedShortDateTime value={summary.createdAt} />
        </span>
      </div>
      <div style={{ minWidth: 0, overflowWrap: 'anywhere', fontSize: 11.5, color: 'var(--muted)' }}>
        {summary.changeReason ?? (changedNames.length > 0 ? 'edited' : 'captured state')}
        {changedNames.length > 0 ? ` · changed: ${changedNames.join(', ')}` : ''}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 0 }}>
        <TextAction onClick={onToggle}>
          {expanded ? `Hide changes in version ${summary.version}` : `Show changes in version ${summary.version}`}
        </TextAction>
        {canManage && (
          <TextAction disabled={busy} onClick={() => onRestore()}>
            {`Restore version ${summary.version}`}
          </TextAction>
        )}
      </div>
      {expanded && detail === 'loading' && (
        <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>Loading…</div>
      )}
      {expanded && detail === 'error' && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 11.5 }}>
          Could not load this version.
        </div>
      )}
      {expanded && loaded && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}
          aria-label={`Values captured in version ${summary.version}`}
        >
          {loaded.redacted && loaded.redactedFields.length === 0 && Object.keys(loaded.values).length === 0 && (
            <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
              The captured values were removed from this version.
            </div>
          )}
          {visible.map((row) => (
            <ValueRow
              key={row.key}
              row={row}
              version={summary.version}
              hasPrevious={loaded.previous !== null}
              canManage={canManage && !row.redacted}
              busy={busy}
              onRestore={() => onRestore(row)}
            />
          ))}
          {changedRows.length > 0 && unchangedCount > 0 && (
            <div>
              <TextAction onClick={() => setShowAll((s) => !s)}>
                {showAll
                  ? 'Hide unchanged fields'
                  : `Show ${unchangedCount} unchanged field${unchangedCount === 1 ? '' : 's'}`}
              </TextAction>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ValueRow({
  row,
  version,
  hasPrevious,
  canManage,
  busy,
  onRestore,
}: {
  row: Row;
  version: number;
  hasPrevious: boolean;
  canManage: boolean;
  busy: boolean;
  onRestore: () => void;
}) {
  const text = formatVersionValue(row.field, row.value);
  const prevText = formatVersionValue(row.field, row.previous);
  return (
    <div
      data-changed={row.changed ? 'true' : 'false'}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: 8,
        rowGap: 2,
        minWidth: 0,
        padding: '3px 6px',
        borderRadius: 4,
        fontSize: 11.5,
        background: row.changed ? 'var(--accent-soft)' : 'transparent',
      }}
    >
      <span style={{ color: 'var(--muted)' }}>{row.label}:</span>
      <span
        style={{
          minWidth: 0,
          overflowWrap: 'anywhere',
          color: 'var(--text)',
          fontWeight: row.changed ? 600 : 400,
        }}
      >
        {row.redacted ? (
          <em style={{ color: 'var(--warn)' }}>(redacted)</em>
        ) : (
          (text ?? <em style={{ color: 'var(--dim)' }}>(empty)</em>)
        )}
      </span>
      {row.changed && <span style={{ fontSize: 10.5, color: 'var(--accent)' }}>changed</span>}
      {row.changed && hasPrevious && (
        <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--muted)' }}>
          was: {prevText ?? <em style={{ color: 'var(--dim)' }}>(empty)</em>}
        </span>
      )}
      {canManage && (
        <TextAction disabled={busy} onClick={onRestore} label={`Restore this ${row.label} from version ${version}`}>
          {`Restore this ${row.label}`}
        </TextAction>
      )}
    </div>
  );
}

function TextAction({
  children,
  disabled,
  onClick,
  label,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      style={{
        border: 0,
        background: 'transparent',
        // Touch-friendly hit area without changing the text size.
        padding: '6px 0',
        minHeight: 32,
        color: disabled ? 'var(--muted)' : 'var(--accent)',
        fontSize: 11.5,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}
