'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationFieldMappingDto,
  IntegrationSyncDirectionValue,
  SourceFieldDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  Field,
  Icon,
  Select,
  Tag,
  useToast,
} from '../../../../../components/ui';
import type {
  LayoutFieldSummary,
  LayoutSummary,
} from '../../../../../lib/server-api';

const DIRECTIONS: Array<{
  value: IntegrationSyncDirectionValue;
  label: string;
  hint: string;
}> = [
  {
    value: 'source_wins',
    label: 'Source wins',
    hint: 'Always overwrite Weavestream with upstream value.',
  },
  {
    value: 'preserve_manual',
    label: 'Preserve manual edits',
    hint: 'Update only when the prior value matches the last sync (no manual change).',
  },
  {
    value: 'manual_only',
    label: 'Manual only',
    hint: 'Never write — pull mapping is dormant. Useful for reference fields.',
  },
];

type FieldRow = {
  /** Stable row id for keyed rendering. */
  rowId: string;
  sourceField: string;
  targetFieldId: string;
  syncDirection: IntegrationSyncDirectionValue;
};

/**
 * Phase 11 — GLOBAL field-mapping editor.
 *
 * One configuration shared across every per-company mapping for this
 * integration:
 *   1. Asset layout (drives target field options).
 *   2. Match-key fields (which AssetField ids the resolver uses to
 *      claim unsynced Weavestream assets).
 *   3. Field mappings (`source field` → `Weavestream field` + direction).
 *      Replace-all semantics — the row order here is the order on disk.
 */
export function FieldMappingsTab({
  integration,
  mappings,
  driver,
}: {
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  driver: DriverDescriptor | null;
}) {
  const router = useRouter();
  const toast = useToast();

  const [layouts, setLayouts] = useState<LayoutSummary[]>([]);
  const [layoutFields, setLayoutFields] = useState<LayoutFieldSummary[]>([]);
  const [loadingLayouts, setLoadingLayouts] = useState(true);
  const [sourceFields, setSourceFields] = useState<SourceFieldDto[]>([]);
  const [sourceFieldsError, setSourceFieldsError] = useState<string | null>(
    null,
  );

  const [assetLayoutId, setAssetLayoutId] = useState<string>(
    integration.assetLayoutId ?? '',
  );
  const [matchKeyFieldIds, setMatchKeyFieldIds] = useState<string[]>(
    integration.matchKeyFieldIds,
  );
  const [fieldMappings, setFieldMappings] = useState<FieldRow[]>([]);
  const [loadingMappings, setLoadingMappings] = useState(true);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -----------------------------------------------------------------
  // Layout list (drives the picker + AssetField options for the chosen
  // layout).
  // -----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingLayouts(true);
      const res = await apiFetch<{ items: LayoutSummary[] }>(`/layouts`);
      if (cancelled) return;
      setLoadingLayouts(false);
      if (!res.ok || !res.data) return;
      setLayouts(res.data.items.filter((l) => !l.archivedAt && l.isActive));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!assetLayoutId) {
      setLayoutFields([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ layout: LayoutSummary }>(
        `/layouts/${assetLayoutId}`,
      );
      if (cancelled) return;
      if (!res.ok || !res.data) return;
      setLayoutFields(
        res.data.layout.fields.filter((f) => !f.archivedAt),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [assetLayoutId]);

  // -----------------------------------------------------------------
  // Existing global field mappings.
  // -----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingMappings(true);
      const res = await apiFetch<IntegrationFieldMappingDto[]>(
        `/admin/integrations/${integration.id}/field-mappings`,
      );
      if (cancelled) return;
      setLoadingMappings(false);
      if (!res.ok || !res.data) return;
      setFieldMappings(
        res.data.map((m) => ({
          rowId: m.id,
          sourceField: m.sourceField,
          targetFieldId: m.targetFieldId,
          syncDirection: m.syncDirection,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [integration.id]);

  // -----------------------------------------------------------------
  // Source fields from the driver. Most drivers (Action1) return a
  // uniform schema regardless of org, so we don't pin a specific one
  // — the API picks the first existing mapping if needed.
  // -----------------------------------------------------------------

  useEffect(() => {
    if (!driver) return;
    let cancelled = false;
    (async () => {
      setSourceFieldsError(null);
      const res = await apiFetch<{ fields: SourceFieldDto[] }>(
        `/admin/integrations/${integration.id}/source-fields`,
      );
      if (cancelled) return;
      if (!res.ok || !res.data) {
        const problem = res.problem as
          | { detail?: string; title?: string }
          | undefined;
        setSourceFieldsError(
          problem?.detail ??
            problem?.title ??
            'Could not list source fields — credentials may be invalid.',
        );
        return;
      }
      setSourceFields(res.data.fields);
    })();
    return () => {
      cancelled = true;
    };
  }, [driver, integration.id, mappings.length]);

  // -----------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------

  const targetFieldIndex = useMemo(() => {
    const idx = new Map<string, LayoutFieldSummary>();
    for (const f of layoutFields) idx.set(f.id, f);
    return idx;
  }, [layoutFields]);

  function addRow() {
    setFieldMappings((prev) => [
      ...prev,
      {
        rowId: tempRowId(),
        sourceField: '',
        targetFieldId: '',
        syncDirection: 'source_wins',
      },
    ]);
  }

  function updateRow(rowId: string, patch: Partial<FieldRow>) {
    setFieldMappings((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }

  function removeRow(rowId: string) {
    setFieldMappings((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  // -----------------------------------------------------------------
  // Save: integration patch (layout + match-keys), then field mappings.
  // The two writes are sequential but the field-mappings PATCH refuses
  // to run when the integration has no layout, so a partial failure
  // here always leaves the operator with a coherent state.
  // -----------------------------------------------------------------

  async function save() {
    setError(null);
    setPending(true);

    const cleanedMappings = fieldMappings
      .filter((r) => r.sourceField.trim() && r.targetFieldId)
      .map((r) => ({
        sourceField: r.sourceField.trim(),
        targetFieldId: r.targetFieldId,
        syncDirection: r.syncDirection,
        transform: null,
      }));

    const dupSources = duplicates(
      cleanedMappings.map((c) => c.sourceField.toLowerCase()),
    );
    const dupTargets = duplicates(cleanedMappings.map((c) => c.targetFieldId));
    if (dupSources.length || dupTargets.length) {
      setPending(false);
      setError(
        dupSources.length
          ? `Duplicate source fields: ${dupSources.join(', ')}`
          : 'A target field is mapped more than once.',
      );
      return;
    }

    if (cleanedMappings.length > 0 && !assetLayoutId) {
      setPending(false);
      setError('Pick an asset layout before saving field mappings.');
      return;
    }

    // 1. Patch integration with layout + match-keys.
    const integrationPatch: Record<string, unknown> = {};
    if ((integration.assetLayoutId ?? null) !== (assetLayoutId || null)) {
      integrationPatch.assetLayoutId = assetLayoutId || null;
    }
    const filteredKeys = matchKeyFieldIds.filter((id) =>
      targetFieldIndex.has(id),
    );
    if (
      JSON.stringify(integration.matchKeyFieldIds) !==
      JSON.stringify(filteredKeys)
    ) {
      integrationPatch.matchKeyFieldIds = filteredKeys;
    }

    if (Object.keys(integrationPatch).length > 0) {
      const intRes = await apiFetch(`/admin/integrations/${integration.id}`, {
        method: 'PATCH',
        body: JSON.stringify(integrationPatch),
      });
      if (!intRes.ok) {
        const problem = intRes.problem as
          | { detail?: string; title?: string }
          | undefined;
        setPending(false);
        setError(
          problem?.detail ??
            problem?.title ??
            'Could not save layout / match-key configuration.',
        );
        return;
      }
    }

    // 2. Replace-all field mappings.
    const fmRes = await apiFetch(
      `/admin/integrations/${integration.id}/field-mappings`,
      {
        method: 'PATCH',
        body: JSON.stringify({ mappings: cleanedMappings }),
      },
    );
    setPending(false);
    if (!fmRes.ok) {
      const problem = fmRes.problem as
        | { detail?: string; title?: string }
        | undefined;
      setError(
        problem?.detail ?? problem?.title ?? 'Could not save field mappings.',
      );
      return;
    }
    toast.push('Field mappings saved.', 'ok');
    router.refresh();
  }

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <header
        style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <h3
          style={{
            margin: 0,
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: -0.2,
          }}
        >
          Global field mappings
        </h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          One configuration drives every per-company mapping for this
          integration. Pick the target asset layout, choose which fields
          identify an existing record, then map each upstream column.
        </p>
      </header>

      <section>
        <h4 style={sectionHeader}>Target asset layout</h4>
        <p style={sectionHelp}>
          Synced records will be written into this layout in every
          mapped Weavestream company. AssetLayouts are global, so this
          choice applies tenant-wide.
        </p>
        {loadingLayouts ? (
          <Tag tone="default">Loading layouts…</Tag>
        ) : (
          <Select
            value={assetLayoutId}
            onChange={(e) => {
              const next = e.target.value;
              setAssetLayoutId(next);
              // Switching layouts invalidates target field ids that
              // belong to the old layout. Reset the rows + match keys
              // so the operator can pick fresh ones — the API would
              // reject the half-broken save otherwise.
              setFieldMappings([]);
              setMatchKeyFieldIds([]);
            }}
            style={{ maxWidth: 360 }}
          >
            <option value="">Select a layout…</option>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
      </section>

      {assetLayoutId && (
        <>
          <section>
            <h4 style={sectionHeader}>Match keys</h4>
            <p style={sectionHelp}>
              When upstream records match unclaimed Weavestream assets
              on these fields, the integration will <strong>claim</strong>{' '}
              the asset instead of creating a duplicate. Text / email /
              URL fields match case-insensitively; everything else is
              exact.
            </p>
            <MatchKeyPicker
              available={layoutFields}
              selected={matchKeyFieldIds}
              onChange={setMatchKeyFieldIds}
            />
          </section>

          <section>
            <header style={sectionHeaderRow}>
              <h4 style={sectionHeader}>Field projections</h4>
              <Btn kind="outline" size="sm" icon={Icon.plus} onClick={addRow}>
                Add row
              </Btn>
            </header>
            {sourceFieldsError && (
              <Tag tone="warn" style={{ marginBottom: 8 }}>
                {sourceFieldsError}
              </Tag>
            )}
            {loadingMappings ? (
              <Tag tone="default">Loading…</Tag>
            ) : fieldMappings.length === 0 ? (
              <div style={emptyState}>
                No field mappings yet — add at least one (e.g.{' '}
                <code>hostname</code> → <code>Hostname</code>) before
                running a sync.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {fieldMappings.map((row) => (
                  <FieldMappingRow
                    key={row.rowId}
                    row={row}
                    sourceFields={sourceFields}
                    layoutFields={layoutFields}
                    onChange={(patch) => updateRow(row.rowId, patch)}
                    onRemove={() => removeRow(row.rowId)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {error && <Tag tone="danger">{error}</Tag>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn kind="primary" onClick={save} loading={pending}>
          Save changes
        </Btn>
      </div>
    </div>
  );
}

function FieldMappingRow({
  row,
  sourceFields,
  layoutFields,
  onChange,
  onRemove,
}: {
  row: FieldRow;
  sourceFields: SourceFieldDto[];
  layoutFields: LayoutFieldSummary[];
  onChange: (patch: Partial<FieldRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 200px 30px',
        gap: 8,
        alignItems: 'start',
      }}
    >
      <Field label="Source field">
        {sourceFields.length > 0 ? (
          <Select
            value={row.sourceField}
            onChange={(e) => onChange({ sourceField: e.target.value })}
          >
            <option value="">Select…</option>
            {sourceFields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label} ({f.key})
              </option>
            ))}
          </Select>
        ) : (
          <input
            value={row.sourceField}
            onChange={(e) => onChange({ sourceField: e.target.value })}
            placeholder="upstream key"
            style={inputStyle}
          />
        )}
      </Field>
      <Field label="Target field">
        <Select
          value={row.targetFieldId}
          onChange={(e) => onChange({ targetFieldId: e.target.value })}
        >
          <option value="">Select…</option>
          {layoutFields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} · {f.fieldType}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Direction"
        help={
          DIRECTIONS.find((d) => d.value === row.syncDirection)?.hint ?? undefined
        }
      >
        <Select
          value={row.syncDirection}
          onChange={(e) =>
            onChange({
              syncDirection: e.target.value as IntegrationSyncDirectionValue,
            })
          }
        >
          {DIRECTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </Select>
      </Field>
      <Btn
        kind="ghost"
        size="sm"
        iconOnly
        icon={Icon.trash}
        onClick={onRemove}
        title="Remove row"
        style={{ marginTop: 22, color: 'var(--muted)' }}
      />
    </div>
  );
}

function MatchKeyPicker({
  available,
  selected,
  onChange,
}: {
  available: LayoutFieldSummary[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(
      selected.includes(id)
        ? selected.filter((s) => s !== id)
        : [...selected, id],
    );
  }
  if (available.length === 0) {
    return <Tag tone="default">Pick a layout to choose match-key fields.</Tag>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {available.map((f) => {
        const on = selected.includes(f.id);
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => toggle(f.id)}
            style={{
              padding: '5px 10px',
              border: `1px solid ${on ? 'var(--accent-line)' : 'var(--line-2)'}`,
              borderRadius: 999,
              background: on ? 'var(--accent-soft)' : 'var(--panel)',
              color: on ? 'var(--accent)' : 'var(--text-2)',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
            }}
            title={`${f.fieldType}${f.isUniquePerCompany ? ' · unique' : ''}`}
          >
            {on && '✓ '}
            {f.name}
          </button>
        );
      })}
    </div>
  );
}

function tempRowId(): string {
  return `tmp_${Math.random().toString(36).slice(2, 10)}`;
}

function duplicates<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const dup = new Set<T>();
  for (const x of arr) {
    if (seen.has(x)) dup.add(x);
    seen.add(x);
  }
  return Array.from(dup);
}

const sectionHeader: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 13.5,
  fontWeight: 600,
  letterSpacing: -0.2,
};

const sectionHelp: React.CSSProperties = {
  margin: '4px 0 10px',
  fontSize: 12,
  color: 'var(--muted)',
};

const sectionHeaderRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 10,
};

const emptyState: React.CSSProperties = {
  padding: 18,
  border: '1px dashed var(--line-2)',
  borderRadius: 6,
  color: 'var(--muted)',
  fontSize: 12.5,
  textAlign: 'center',
};

const inputStyle: React.CSSProperties = {
  height: 32,
  padding: '0 10px',
  background: 'var(--panel-2)',
  border: '1px solid var(--line-2)',
  borderRadius: 5,
  color: 'var(--text)',
  fontSize: 13,
  fontFamily: 'var(--font-mono)',
  width: '100%',
};
