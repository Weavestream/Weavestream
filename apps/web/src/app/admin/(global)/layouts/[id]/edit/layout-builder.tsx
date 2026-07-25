'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { randomClientId } from '../../../../../../lib/client-id';
import { lower } from '../../../../../../lib/term';
import { useTerm } from '../../../../../../lib/term-context';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FIELD_TYPE_CATALOG,
  type FieldType,
  type FieldTypeMeta,
  canShowInTable,
  fieldOptionsSchemaFor,
  getLayoutTemplate,
  saveAssetFieldsSchema,
} from '@weavestream/shared';
import type { LayoutStats, LayoutSummary, LayoutFieldSummary } from '../../../../../../lib/server-api';
import { apiFetch } from '../../../../../../lib/api';
import {
  Btn,
  Icon,
  LayoutSwatch,
  Tag,
  useToast,
} from '../../../../../../components/ui';
import { PageHeader } from '../../../../../../components/shell/page-header';
import { useIsMobile } from '../../../../../../lib/hooks/use-is-mobile';
import { LayoutSettingsDialog } from '../../layout-settings-dialog';
import { LayoutArchiveDialog } from '../../layout-archive-dialog';

type BuilderField = {
  /** Persisted id, or undefined for unsaved rows. */
  id?: string;
  /** Stable key across the builder's lifetime — required by @dnd-kit. */
  key: string;
  name: string;
  slug: string;
  fieldType: FieldType;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  /**
   * When true, this field is rendered as a column in the per-layout
   * asset table view. The primary field is implicitly included as the
   * first column, so `isPrimary` effectively wins and the inspector
   * locks the toggle there.
   */
  showInTable: boolean;
  options: Record<string, unknown>;
};

const newKey = () => `new-${randomClientId()}`;

function toBuilder(f: LayoutFieldSummary): BuilderField {
  return {
    id: f.id,
    key: f.id,
    name: f.name,
    slug: f.slug,
    fieldType: f.fieldType,
    isRequired: f.isRequired,
    isUniquePerCompany: f.isUniquePerCompany,
    visibleToClients: f.visibleToClients,
    isPrimary: f.isPrimary,
    showInTable: f.showInTable,
    options: f.options ?? {},
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

function defaultOptionsFor(kind: FieldType): Record<string, unknown> {
  switch (kind) {
    // New DROPDOWN/MULTISELECT rows start with no choices so the operator
    // fills them in explicitly rather than shipping with a "Option A" stub
    // that looks like real data. The save validator requires ≥1 choice,
    // which surfaces as an inline error if they save an empty list.
    case 'DROPDOWN':
      return { choices: [], allowOther: false };
    case 'MULTISELECT':
      return { choices: [] };
    case 'DATE':
    case 'DATETIME':
      return { isExpiry: false };
    case 'ASSET_REFERENCE':
      return { targetLayoutId: '', multiple: false };
    case 'FILE':
      return { maxSizeMb: 25, multiple: false };
    case 'IP_ADDRESS':
      return { version: 'any', allowCidr: false };
    default:
      return {};
  }
}

export function LayoutBuilder({
  layout,
  stats,
  canEdit,
  allLayouts,
}: {
  layout: LayoutSummary;
  stats: LayoutStats | null;
  canEdit: boolean;
  allLayouts: LayoutSummary[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const term = useTerm();
  const isMobile = useIsMobile();
  const activeFields = useMemo(
    () =>
      layout.fields.filter((f) => !f.archivedAt).sort((a, b) => a.position - b.position),
    [layout.fields],
  );

  const [fields, setFields] = useState<BuilderField[]>(
    () => activeFields.map(toBuilder),
  );
  // `baseline` is the last-known-persisted snapshot. Dirty state compares
  // current `fields` against this, so a successful save can reset the
  // baseline in one place and the "unsaved" chip disappears without
  // waiting for the parent server component to hand us fresh props.
  const [baseline, setBaseline] = useState<BuilderField[]>(
    () => activeFields.map(toBuilder),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(
    () => activeFields[0]?.id ?? null,
  );
  const [activeDragType, setActiveDragType] = useState<FieldType | null>(null);
  const [activeDragFieldKey, setActiveDragFieldKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forcePrompt, setForcePrompt] = useState<null | {
    affectedAssetCount: number;
    affectedCompanyIds: string[];
  }>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const isArchived = layout.archivedAt !== null;

  // When the server component re-renders with a new layout version (after
  // `router.refresh()`), pull the fresh field list in as the new baseline
  // + working copy so stable server IDs replace our transient `new-*`
  // keys and future diffs are computed against authoritative data.
  const lastVersion = useRef<number>(layout.version);
  useEffect(() => {
    if (layout.version !== lastVersion.current) {
      lastVersion.current = layout.version;
      const fresh = activeFields.map(toBuilder);
      setFields(fresh);
      setBaseline(fresh);
    }
  }, [layout.version, activeFields]);

  // Starter-template seeding: when the builder is opened with
  // `?template=<id>` (set by the create-layout dialog) AND the layout
  // has no persisted fields yet AND the viewer can edit, pre-populate
  // the local field list from the template catalog. Fields are left
  // without an `id` so the save diff treats them as brand-new rows,
  // and `baseline` is intentionally not updated so the "unsaved" chip
  // lights up immediately. The query param is stripped after the
  // seed so a refresh doesn't clobber in-progress edits with the
  // original template fields.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const templateId = searchParams.get('template');
    if (!templateId) return;
    // Mark before any early return so the effect only ever fires once
    // per mount — even if the template is invalid or the layout
    // already has fields, the URL gets cleaned up on the same pass.
    seededRef.current = true;
    const stripParam = () => {
      const next = new URLSearchParams(searchParams.toString());
      next.delete('template');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    };
    if (!canEdit || activeFields.length > 0) {
      stripParam();
      return;
    }
    const template = getLayoutTemplate(templateId);
    if (!template) {
      stripParam();
      return;
    }
    const hasPrimary = template.fields.some((f) => f.isPrimary === true);
    const seeded: BuilderField[] = template.fields.map((f, idx) => ({
      key: newKey(),
      name: f.name,
      slug: f.slug,
      fieldType: f.fieldType,
      isRequired: f.isRequired ?? false,
      isUniquePerCompany: false,
      visibleToClients: f.visibleToClients ?? true,
      // Templates should always mark a primary, but fall back to the
      // first field if one is missing so the Save validator (which
      // requires exactly one primary) doesn't reject on load.
      isPrimary: f.isPrimary === true || (!hasPrimary && idx === 0),
      showInTable:
        (f.showInTable ?? false) && canShowInTable(f.fieldType),
      // Merge template-supplied options on top of the kind's default
      // skeleton so DROPDOWN/IP_ADDRESS/DATE keep all required keys
      // even if the template only overrides a subset.
      options: { ...defaultOptionsFor(f.fieldType), ...(f.options ?? {}) },
    }));
    setFields(seeded);
    setSelectedKey(seeded[0]?.key ?? null);
    stripParam();
  }, [searchParams, pathname, router, canEdit, activeFields.length]);

  const dirty = useMemo(() => {
    if (fields.length !== baseline.length) return true;
    for (let i = 0; i < fields.length; i++) {
      const a = fields[i]!;
      const b = baseline[i]!;
      if (a.id !== b.id) return true;
      if (
        a.name !== b.name ||
        a.slug !== b.slug ||
        a.fieldType !== b.fieldType ||
        a.isRequired !== b.isRequired ||
        a.isUniquePerCompany !== b.isUniquePerCompany ||
        a.visibleToClients !== b.visibleToClients ||
        a.isPrimary !== b.isPrimary ||
        a.showInTable !== b.showInTable ||
        JSON.stringify(a.options) !== JSON.stringify(b.options)
      ) {
        return true;
      }
    }
    return false;
  }, [fields, baseline]);

  const selected = fields.find((f) => f.key === selectedKey) ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const addFieldOfType = useCallback(
    (kind: FieldType, atIndex?: number) => {
      const hasPrimary = fields.some((f) => f.isPrimary);
      // New rows start with empty label + slug so the inspector renders a
      // placeholder hint instead of "Text"/"text" stubs that look like real
      // values. The label → slug auto-fill keeps them linked until the user
      // touches the slug manually; save validation enforces non-empty.
      const next: BuilderField = {
        key: newKey(),
        name: '',
        slug: '',
        fieldType: kind,
        isRequired: false,
        isUniquePerCompany: false,
        visibleToClients: true,
        isPrimary: !hasPrimary,
        showInTable: false,
        options: defaultOptionsFor(kind),
      };
      setFields((cur) => {
        const copy = [...cur];
        const insertAt = atIndex ?? copy.length;
        copy.splice(insertAt, 0, next);
        return copy;
      });
      setSelectedKey(next.key);
    },
    [fields],
  );

  const removeField = useCallback(
    (key: string) => {
      setFields((cur) => {
        const next = cur.filter((f) => f.key !== key);
        if (next.length > 0 && !next.some((f) => f.isPrimary)) {
          next[0] = { ...next[0]!, isPrimary: true };
        }
        return next;
      });
      setSelectedKey((cur) => (cur === key ? null : cur));
    },
    [],
  );

  const updateField = useCallback(
    (key: string, patch: Partial<BuilderField>) => {
      setFields((cur) =>
        cur.map((f) =>
          f.key === key
            ? {
                ...f,
                ...patch,
                options: patch.options ? { ...patch.options } : f.options,
              }
            : f,
        ),
      );
    },
    [],
  );

  const setPrimary = useCallback((key: string) => {
    setFields((cur) => cur.map((f) => ({ ...f, isPrimary: f.key === key })));
  }, []);

  function onDragStart(e: DragStartEvent) {
    const id = e.active.id.toString();
    if (id.startsWith('palette:')) {
      setActiveDragType(id.slice('palette:'.length) as FieldType);
    } else {
      setActiveDragFieldKey(id);
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const activeId = e.active.id.toString();
    const overId = e.over?.id?.toString();
    setActiveDragType(null);
    setActiveDragFieldKey(null);
    if (!overId) return;

    // Palette → canvas: add new field at the target position.
    if (activeId.startsWith('palette:')) {
      const kind = activeId.slice('palette:'.length) as FieldType;
      const idx =
        overId === 'canvas-dropzone'
          ? fields.length
          : fields.findIndex((f) => f.key === overId);
      addFieldOfType(kind, idx < 0 ? fields.length : idx);
      return;
    }

    // Canvas → canvas: reorder.
    if (activeId !== overId) {
      const fromIdx = fields.findIndex((f) => f.key === activeId);
      const toIdx = fields.findIndex((f) => f.key === overId);
      if (fromIdx < 0 || toIdx < 0) return;
      setFields((cur) => arrayMove(cur, fromIdx, toIdx));
    }
  }

  async function save(force: boolean) {
    setError(null);
    setForcePrompt(null);

    const payload = {
      fields: fields.map((f, i) => ({
        ...(f.id ? { id: f.id } : {}),
        name: f.name,
        slug: f.slug,
        fieldType: f.fieldType,
        position: i,
        isRequired: f.isRequired,
        isUniquePerCompany: f.isUniquePerCompany,
        visibleToClients: f.visibleToClients,
        isPrimary: f.isPrimary,
        // Non-tabular types can never be table columns — strip the
        // flag defensively before sending so the server never sees a
        // stale value from a field whose type changed.
        showInTable: canShowInTable(f.fieldType) && f.showInTable,
        options: f.options,
      })),
    };

    // Validate each field's options locally against the shared schema
    // before the round-trip so the UI can highlight inline errors.
    for (const f of payload.fields) {
      const res = fieldOptionsSchemaFor(f.fieldType).safeParse(f.options);
      if (!res.success) {
        setError(
          `Field "${f.slug}" (${f.fieldType}) has invalid options: ${
            res.error.issues[0]?.message ?? 'check the inspector.'
          }`,
        );
        return;
      }
    }
    const parsed = saveAssetFieldsSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Fix the errors above.');
      return;
    }

    setSaving(true);
    const res = await apiFetch<LayoutSummary>(
      `/layouts/${layout.id}/fields${force ? '?force=true' : ''}`,
      { method: 'PUT', body: JSON.stringify(parsed.data) },
    );
    setSaving(false);

    if (res.ok) {
      // Prefer the server's response so transient `new-*` keys are
      // replaced by persisted IDs immediately; fall back to the local
      // snapshot if the API ever shipped a thinner response.
      const serverFields = res.data?.fields
        ?.filter((f) => !f.archivedAt)
        .sort((a, b) => a.position - b.position)
        .map(toBuilder);
      if (serverFields) {
        setFields(serverFields);
        setBaseline(serverFields);
        // Re-anchor selection on the corresponding saved row, by slug
        // (stable across save) since the row's `key` just got replaced.
        setSelectedKey((cur) => {
          if (!cur) return null;
          const current = fields.find((f) => f.key === cur);
          if (!current) return null;
          const replacement = serverFields.find((f) => f.slug === current.slug);
          return replacement?.key ?? null;
        });
      } else {
        setBaseline(fields.map((f) => ({ ...f, options: { ...f.options } })));
      }
      toast.push('Layout saved', 'ok');
      router.refresh();
      return;
    }

    // RFC 7807 extension members live at the top level alongside
    // `detail` / `title` — see ProblemExceptionFilter.
    const problem = res.problem as
      | {
          status?: number;
          detail?: string;
          title?: string;
          error?: string;
          affectedAssetCount?: number;
          affectedCompanyIds?: string[];
          message?: string;
        }
      | undefined;

    if (problem?.error === 'DestructiveFieldRemoval') {
      setForcePrompt({
        affectedAssetCount: problem.affectedAssetCount ?? 0,
        affectedCompanyIds: problem.affectedCompanyIds ?? [],
      });
      return;
    }
    setError(problem?.message ?? problem?.detail ?? problem?.title ?? 'Save failed.');
  }

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <PageHeader
          crumbs={[
            { label: 'Layouts', href: '/admin/layouts' },
            { label: layout.name },
            { label: 'edit', mono: true },
          ]}
          leading={
            <LayoutSwatch icon={layout.icon} color={layout.color} size={48} />
          }
          title={layout.name}
          description={
            <>
              v{layout.version} · {activeFields.length} field
              {activeFields.length === 1 ? '' : 's'}
              {stats &&
                ` · used by ${stats.assetCount} asset${stats.assetCount === 1 ? '' : 's'} in ${stats.companyCount} ${
                  stats.companyCount === 1 ? lower(term.one) : lower(term.other)
                }`}
            </>
          }
          actions={<Tag tone="outline">read only</Tag>}
        />
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '16px 16px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              background: 'var(--warn-soft, var(--panel))',
              border: '1px solid var(--warn-line, var(--line))',
              borderRadius: 8,
              color: 'var(--text)',
              fontSize: 13,
            }}
          >
            <Icon.warn size={16} style={{ flexShrink: 0, color: 'var(--warn, var(--muted))' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong style={{ fontSize: 13, fontWeight: 600 }}>
                Best viewed on a larger screen
              </strong>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                The layout builder is drag-and-drop and needs a desktop viewport.
                A read-only preview of the current fields is below.
              </span>
            </div>
          </div>

          {activeFields.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13,
                border: '1px dashed var(--line)',
                borderRadius: 8,
              }}
            >
              No fields defined yet.
            </div>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {activeFields.map((f) => {
                const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === f.fieldType);
                return (
                  <li
                    key={f.id}
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      padding: 12,
                      background: 'var(--panel)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>
                        {f.name}
                      </span>
                      {f.isPrimary && <Tag tone="accent">primary</Tag>}
                      {f.isRequired && <Tag tone="warn">required</Tag>}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--dim)',
                      }}
                    >
                      /{f.slug} · {meta?.label ?? f.fieldType}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {f.isUniquePerCompany && <Tag tone="outline">unique</Tag>}
                      {!f.visibleToClients && <Tag tone="outline">internal</Tag>}
                      {f.showInTable && <Tag tone="outline">in table</Tag>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {/* Trailing inset: this div is the scroll container, and a
              scroll container's block-end padding never reaches the
              scrollable overflow region, so the last field card would
              sit flush on the bottom edge. `marginTop` cancels the
              flex gap. See the same note in `PageBody`. */}
          <div
            aria-hidden
            style={{ height: 16, flex: '0 0 auto', marginTop: -16 }}
          />
        </div>
      </div>
    );
  }

  const tableColumnCount = fields.filter(
    (f) => f.isPrimary || (f.showInTable && canShowInTable(f.fieldType)),
  ).length;

  const headerDescription = (
    <>
      v{layout.version} · {fields.length} field{fields.length === 1 ? '' : 's'}
      {stats &&
        ` · used by ${stats.assetCount} asset${stats.assetCount === 1 ? '' : 's'} in ${stats.companyCount} ${
          stats.companyCount === 1 ? lower(term.one) : lower(term.other)
        }`}
    </>
  );

  const titleNode = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        minWidth: 0,
      }}
    >
      <span style={{ minWidth: 0 }}>{layout.name}</span>
      {isArchived && <Tag tone="warn">archived</Tag>}
      {!isArchived && dirty && <Tag tone="warn">unsaved</Tag>}
    </span>
  );

  const headerActions = canEdit ? (
    <>
      <Btn
        kind="outline"
        size="md"
        onClick={() => router.push('/admin/layouts')}
        disabled={saving}
      >
        Cancel
      </Btn>
      <Btn
        kind="outline"
        size="md"
        icon={Icon.edit}
        onClick={() => setSettingsOpen(true)}
        disabled={saving}
        title="Rename layout or change icon/color"
      >
        Settings
      </Btn>
      <Btn
        kind="outline"
        size="md"
        icon={isArchived ? Icon.check : Icon.archive}
        onClick={() => setArchiveOpen(true)}
        disabled={saving}
      >
        {isArchived ? 'Restore' : 'Archive'}
      </Btn>
      {!isArchived && (
        <Btn
          kind="primary"
          size="md"
          icon={Icon.check}
          loading={saving}
          disabled={!dirty || saving}
          onClick={() => save(false)}
        >
          Save layout
        </Btn>
      )}
    </>
  ) : (
    <Tag tone="outline">read only</Tag>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        crumbs={[
          { label: 'Layouts', href: '/admin/layouts' },
          { label: layout.name },
          { label: 'edit', mono: true },
        ]}
        leading={
          <LayoutSwatch icon={layout.icon} color={layout.color} size={48} />
        }
        title={titleNode}
        description={headerDescription}
        actions={headerActions}
      />

      {error && (
        <div
          role="alert"
          style={{
            padding: '10px 20px',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            borderBottom: '1px solid var(--line)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      {isArchived && (
        <div
          role="note"
          style={{
            padding: '10px 20px',
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
            borderBottom: '1px solid var(--line)',
            fontSize: 12.5,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Icon.archive size={13} />
          <div style={{ flex: 1 }}>
            This layout is archived — restore it to resume editing fields.
            Existing assets linked to this layout continue to work.
          </div>
          {canEdit && (
            <Btn
              kind="primary"
              size="sm"
              icon={Icon.check}
              onClick={() => setArchiveOpen(true)}
            >
              Restore
            </Btn>
          )}
        </div>
      )}

      {forcePrompt && (
        <div
          role="alertdialog"
          style={{
            padding: '12px 20px',
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 12.5,
          }}
        >
          <Icon.warn size={14} />
          <div style={{ flex: 1 }}>
            Removing these fields will delete values on{' '}
            <b>{forcePrompt.affectedAssetCount}</b> asset
            {forcePrompt.affectedAssetCount === 1 ? '' : 's'} across{' '}
            <b>{forcePrompt.affectedCompanyIds.length}</b>{' '}
            {forcePrompt.affectedCompanyIds.length === 1
              ? lower(term.one)
              : lower(term.other)}
            . This cannot be undone.
          </div>
          <Btn kind="ghost" size="sm" onClick={() => setForcePrompt(null)}>
            Cancel
          </Btn>
          <Btn kind="danger" size="sm" onClick={() => save(true)} loading={saving}>
            Force save
          </Btn>
        </div>
      )}

      {tableColumnCount > 10 && (
        <div
          role="note"
          style={{
            padding: '10px 20px',
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
            borderBottom: '1px solid var(--line)',
            fontSize: 12.5,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Icon.warn size={13} />
          <div style={{ flex: 1 }}>
            Large column count ({tableColumnCount}). The table view may scroll
            horizontally on narrow screens.
          </div>
        </div>
      )}

      <DndContext
        id="layout-builder-dnd"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            background: 'var(--bg)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '220px 1fr 300px',
              minHeight: '100%',
            }}
          >
            <FieldTypePalette disabled={!canEdit} />

            <div style={{ padding: '20px 24px', minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  margin: '0 0 8px',
                  padding: '0 4px',
                }}
              >
                Fields{canEdit ? ' · drag to reorder' : ''}
              </div>

              <SortableContext
                items={fields.map((f) => f.key)}
                strategy={verticalListSortingStrategy}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {fields.map((f) => (
                    <SortableFieldRow
                      key={f.key}
                      field={f}
                      selected={selectedKey === f.key}
                      onSelect={() => setSelectedKey(f.key)}
                      onRemove={() => removeField(f.key)}
                      canEdit={canEdit}
                    />
                  ))}
                </div>
              </SortableContext>

              <CanvasDropzone canEdit={canEdit} />
            </div>

            <FieldInspector
              field={selected}
              canEdit={canEdit}
              onChange={(patch) => selected && updateField(selected.key, patch)}
              onSlugAutoFill={(label) => {
                if (selected) updateField(selected.key, { slug: slugify(label) });
              }}
              onMakePrimary={(key) => setPrimary(key)}
              allLayouts={allLayouts}
              currentLayoutId={layout.id}
            />
          </div>
        </div>

        <DragOverlay>
          {activeDragType ? <PaletteChip kind={activeDragType} overlay /> : null}
          {activeDragFieldKey
            ? (() => {
                const f = fields.find((x) => x.key === activeDragFieldKey);
                if (!f) return null;
                return <FieldRowOverlay field={f} />;
              })()
            : null}
        </DragOverlay>
      </DndContext>

      {canEdit && (
        <>
          <LayoutSettingsDialog
            layout={layout}
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
          />
          <LayoutArchiveDialog
            layout={layout}
            stats={stats}
            open={archiveOpen}
            onClose={() => setArchiveOpen(false)}
          />
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Palette
// ────────────────────────────────────────────────────────────────────

const PROMOTED_PALETTE_FIELD_TYPES: readonly FieldType[] = [
  'TEXT',
  'TEXTAREA',
  'RICH_TEXT',
  'ASSET_REFERENCE',
];

const PROMOTED_PALETTE_FIELD_TYPE_SET = new Set(PROMOTED_PALETTE_FIELD_TYPES);

const LINKED_ASSET_TOOLTIP =
  'Link this asset to another asset so people can quickly find and open related records.';

const PALETTE_FIELD_TYPES: readonly FieldType[] = [
  ...PROMOTED_PALETTE_FIELD_TYPES,
  ...FIELD_TYPE_CATALOG.map((meta) => meta.kind).filter(
    (kind) =>
      kind !== 'VAULTWARDEN_LINK' && !PROMOTED_PALETTE_FIELD_TYPE_SET.has(kind),
  ),
];

function FieldTypePalette({ disabled }: { disabled: boolean }) {
  return (
    <aside
      style={{
        borderRight: '1px solid var(--line)',
        background: 'var(--surface)',
      }}
    >
      <div style={{ position: 'sticky', top: 0, padding: 18 }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 10,
          }}
        >
          Field types
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {PALETTE_FIELD_TYPES.map((kind) => (
            <PaletteChip key={kind} kind={kind} disabled={disabled} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function PaletteChip({
  kind,
  overlay,
  disabled,
}: {
  kind: FieldType;
  overlay?: boolean;
  disabled?: boolean;
}) {
  const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === kind)!;
  const [showInfoTooltip, setShowInfoTooltip] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${kind}`,
    disabled,
  });
  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : attributes)}
      {...(overlay || disabled ? {} : listeners)}
      style={{
        padding: '7px 10px',
        border: '1px solid var(--line)',
        borderRadius: 4,
        fontSize: 12.5,
        background: 'var(--panel)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : overlay ? 'grabbing' : 'grab',
        opacity: isDragging && !overlay ? 0.4 : 1,
        boxShadow: overlay
          ? '0 8px 22px -6px color-mix(in oklch, var(--accent) 30%, transparent)'
          : 'none',
      }}
    >
      <Icon.grip size={11} style={{ color: 'var(--dim)' }} />
      <span>{meta.label}</span>
      {!overlay && meta.kind === 'ASSET_REFERENCE' && (
        <button
          type="button"
          aria-label={`About Linked asset: ${LINKED_ASSET_TOOLTIP}`}
          aria-describedby="linked-asset-field-type-description"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onMouseEnter={() => setShowInfoTooltip(true)}
          onMouseLeave={() => setShowInfoTooltip(false)}
          onFocus={() => setShowInfoTooltip(true)}
          onBlur={() => setShowInfoTooltip(false)}
          style={{
            position: 'relative',
            marginLeft: 'auto',
            width: 16,
            height: 16,
            padding: 0,
            border: 0,
            borderRadius: 3,
            background: 'transparent',
            color: 'var(--muted)',
            display: 'inline-grid',
            placeItems: 'center',
            flex: '0 0 auto',
            cursor: 'help',
          }}
        >
          <Icon.info size={14} />
          <span
            id="linked-asset-field-type-description"
            role="tooltip"
            style={{
              position: 'absolute',
              left: 'calc(100% + 10px)',
              top: '50%',
              width: 240,
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 5,
              background: 'var(--panel)',
              boxShadow: '0 8px 24px -8px rgb(0 0 0 / 35%)',
              color: 'var(--text)',
              fontFamily: 'var(--font-sans)',
              fontSize: 11.5,
              fontWeight: 400,
              lineHeight: 1.45,
              textAlign: 'left',
              transform: 'translateY(-50%)',
              display: showInfoTooltip ? 'block' : 'none',
              pointerEvents: 'none',
              zIndex: 30,
            }}
          >
            {LINKED_ASSET_TOOLTIP}
          </span>
        </button>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Canvas rows
// ────────────────────────────────────────────────────────────────────

function SortableFieldRow({
  field,
  selected,
  onSelect,
  onRemove,
  canEdit,
}: {
  field: BuilderField;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  canEdit: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.key, disabled: !canEdit });
  const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === field.fieldType)!;

  return (
    <div
      ref={setNodeRef}
      onClick={onSelect}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        padding: '10px 12px',
        display: 'grid',
        gridTemplateColumns: '16px 1fr 120px 120px auto',
        gap: 12,
        alignItems: 'center',
        background: selected ? 'var(--panel-2)' : 'var(--panel)',
        border: `1px solid ${selected ? 'var(--accent-line)' : 'var(--line)'}`,
        borderRadius: 5,
        boxShadow: selected ? '0 0 0 3px var(--accent-soft)' : 'none',
        opacity: isDragging ? 0 : 1,
        cursor: 'pointer',
      }}
    >
      <div
        {...(canEdit ? attributes : {})}
        {...(canEdit ? listeners : {})}
        style={{ cursor: canEdit ? 'grab' : 'default', display: 'grid', placeItems: 'center' }}
        onClick={(e) => e.stopPropagation()}
        aria-label="Drag handle"
      >
        <Icon.grip size={13} style={{ color: 'var(--dim)' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {field.name || '(untitled)'}
        </span>
        {field.isPrimary && <Tag tone="accent">primary</Tag>}
        {field.isRequired && <Tag tone="warn">required</Tag>}
        {field.isUniquePerCompany && <Tag tone="outline">unique</Tag>}
        {!field.visibleToClients && <Tag tone="outline">internal</Tag>}
        {!field.isPrimary &&
          field.showInTable &&
          canShowInTable(field.fieldType) && <Tag tone="outline">column</Tag>}
      </div>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--muted)',
        }}
      >
        {meta.label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--dim)',
        }}
      >
        {field.slug}
      </span>
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        {canEdit && (
          <Btn
            size="sm"
            kind="ghost"
            icon={Icon.trash}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Remove field"
          />
        )}
      </div>
    </div>
  );
}

function FieldRowOverlay({ field }: { field: BuilderField }) {
  const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === field.fieldType)!;
  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'var(--panel-2)',
        border: '1px solid var(--accent-line)',
        borderRadius: 5,
        fontSize: 13,
        boxShadow:
          '0 14px 30px -10px color-mix(in oklch, var(--accent) 35%, transparent)',
      }}
    >
      {field.name} <span style={{ color: 'var(--dim)' }}>· {meta.label}</span>
    </div>
  );
}

function CanvasDropzone({ canEdit }: { canEdit: boolean }) {
  const { isOver, setNodeRef } = useDroppable({ id: 'canvas-dropzone' });
  return (
    <div
      ref={setNodeRef}
      style={{
        marginTop: 8,
        padding: 14,
        border: `1px dashed ${isOver ? 'var(--accent-line)' : 'var(--line-2)'}`,
        background: isOver ? 'var(--accent-soft)' : 'transparent',
        borderRadius: 5,
        textAlign: 'center',
        fontSize: 12,
        color: 'var(--dim)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {canEdit ? (
        <>drop a field here or use the palette on the left</>
      ) : (
        <>read-only view — only super-admins can edit the catalog</>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Inspector
// ────────────────────────────────────────────────────────────────────

function FieldInspector({
  field,
  canEdit,
  onChange,
  onSlugAutoFill,
  onMakePrimary,
  allLayouts,
  currentLayoutId,
}: {
  field: BuilderField | null;
  canEdit: boolean;
  onChange: (patch: Partial<BuilderField>) => void;
  onSlugAutoFill: (label: string) => void;
  /**
   * Transfer primary designation to this field. Uses a dedicated
   * callback (rather than `onChange({ isPrimary: true })`) so the
   * previous primary gets demoted atomically — `updateField` only
   * touches one row and would otherwise leave two primaries.
   */
  onMakePrimary: (key: string) => void;
  allLayouts: LayoutSummary[];
  currentLayoutId: string;
}) {
  const term = useTerm();
  if (!field) {
    return (
      <aside
        style={{
          padding: 18,
          borderLeft: '1px solid var(--line)',
          background: 'var(--surface)',
          color: 'var(--muted)',
          fontSize: 12.5,
        }}
      >
        Select a field to inspect.
      </aside>
    );
  }
  const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === field.fieldType)!;
  const readOnly = !canEdit;
  const isPersisted = !!field.id;

  return (
    <aside
      style={{
        padding: 18,
        borderLeft: '1px solid var(--line)',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minHeight: '100%',
        minWidth: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        Field inspector
      </div>

      <InspectorInput
        label="Label"
        value={field.name}
        placeholder={meta.label}
        readOnly={readOnly}
        onChange={(v) => {
          onChange({ name: v });
          if (!field.id) onSlugAutoFill(v);
        }}
      />

      <InspectorInput
        label="Slug"
        value={field.slug}
        placeholder={meta.slug}
        mono
        readOnly={readOnly}
        onChange={(v) => onChange({ slug: slugify(v) })}
        help={isPersisted ? 'Avoid renaming — slugs are referenced in filters.' : undefined}
      />

      <InspectorField label="Type">
        <div
          className="inp"
          style={{
            ...inspectorInputStyle,
            display: 'flex',
            alignItems: 'center',
            color: isPersisted ? 'var(--muted)' : 'var(--text)',
            cursor: isPersisted ? 'not-allowed' : 'default',
          }}
        >
          {meta.label}
          <span style={{ flex: 1 }} />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
            }}
          >
            {meta.slug}
          </span>
        </div>
      </InspectorField>

      {meta.hint && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
            padding: '0 2px',
          }}
        >
          {meta.hint}
        </div>
      )}

      {meta.hasOptions && (
        <OptionsEditor
          field={field}
          meta={meta}
          onChange={onChange}
          readOnly={readOnly}
          allLayouts={allLayouts}
          currentLayoutId={currentLayoutId}
        />
      )}

      <div>
        <ToggleRow
          label="Required"
          value={field.isRequired}
          onChange={(v) => onChange({ isRequired: v })}
          disabled={readOnly}
        />
        <ToggleRow
          label={`Unique per ${lower(term.one)}`}
          value={field.isUniquePerCompany}
          onChange={(v) => onChange({ isUniquePerCompany: v })}
          disabled={readOnly}
        />
        <ToggleRow
          label="Visible to clients"
          value={field.visibleToClients}
          onChange={(v) => onChange({ visibleToClients: v })}
          disabled={readOnly}
        />
        <ToggleRow
          label="Primary (asset name)"
          value={field.isPrimary}
          onChange={(v) => {
            // Only the ON direction is actionable here — a layout must
            // always have exactly one primary, so the current primary's
            // toggle is disabled below. Flipping ON another field's
            // toggle transfers the designation (demoting the old one
            // in the same state update).
            if (v && !field.isPrimary) onMakePrimary(field.key);
          }}
          disabled={readOnly || field.isPrimary}
          help={
            field.isPrimary
              ? 'Primary is locked to this field. Flip another field\u2019s Primary toggle (or click the \u2605 on its row) to move it.'
              : 'Turning this on will demote the current primary.'
          }
        />
        {/* "Show as column in table view" — the per-layout asset table
            renders primary as the first column by default, so it's
            always effectively ON for the primary; non-tabular types
            (RICH_TEXT, FILE) are locked OFF because their cells can't
            be summarised. */}
        {field.isPrimary ? (
          <ToggleRow
            label="Show as column in table view"
            value={true}
            onChange={() => {
              /* locked on for primary */
            }}
            disabled
            help="Always shown as the first column — this is the asset name."
          />
        ) : canShowInTable(field.fieldType) ? (
          <ToggleRow
            label="Show as column in table view"
            value={field.showInTable}
            onChange={(v) => onChange({ showInTable: v })}
            disabled={readOnly}
            help="Adds this field as a column in the per-layout asset table."
          />
        ) : (
          <ToggleRow
            label="Show as column in table view"
            value={false}
            onChange={() => {
              /* locked off for non-tabular types */
            }}
            disabled
            help={`${meta.label} values don\u2019t render cleanly in a table cell.`}
          />
        )}
      </div>
    </aside>
  );
}

const inspectorInputStyle = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: '6px 8px',
  fontSize: 12.5,
  color: 'var(--text)',
  outline: 'none',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box' as const,
};

function InspectorField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

function InspectorInput({
  label,
  value,
  onChange,
  mono,
  readOnly,
  help,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  readOnly?: boolean;
  help?: string;
  placeholder?: string;
}) {
  return (
    <InspectorField label={label} hint={help}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        placeholder={placeholder}
        className="inp"
        style={{
          ...inspectorInputStyle,
          ...(mono ? { fontFamily: 'var(--font-mono)' } : {}),
          ...(readOnly ? { color: 'var(--muted)' } : {}),
        }}
      />
    </InspectorField>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  disabled,
  help,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  help?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '6px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1, fontSize: 12.5 }}>{label}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(!value)}
          aria-pressed={value}
          style={{
            width: 28,
            height: 16,
            borderRadius: 9,
            background: value ? 'var(--accent)' : 'var(--line-3)',
            position: 'relative',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            transition: 'background 160ms ease',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 1,
              left: value ? 14 : 1,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: value ? 'var(--accent-ink)' : 'var(--text-2)',
              transition: 'left 160ms ease',
            }}
          />
        </button>
      </div>
      {help && (
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
            marginTop: 3,
          }}
        >
          {help}
        </span>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Options editors (per FieldType)
// ────────────────────────────────────────────────────────────────────

function OptionsEditor({
  field,
  meta,
  onChange,
  readOnly,
  allLayouts,
  currentLayoutId,
}: {
  field: BuilderField;
  meta: FieldTypeMeta;
  onChange: (patch: Partial<BuilderField>) => void;
  readOnly: boolean;
  allLayouts: LayoutSummary[];
  currentLayoutId: string;
}) {
  switch (field.fieldType) {
    case 'DROPDOWN':
    case 'MULTISELECT':
      return (
        <ChoicesEditor
          options={field.options}
          onChange={(opts) => onChange({ options: opts })}
          readOnly={readOnly}
          allowAllowOther={field.fieldType === 'DROPDOWN'}
          allowMax={field.fieldType === 'MULTISELECT'}
        />
      );
    case 'DATE':
    case 'DATETIME':
      return (
        <InspectorField label="Options">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ToggleRow
              label="Treat as expiry"
              value={!!field.options.isExpiry}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, isExpiry: v },
                })
              }
              disabled={readOnly}
              help="Drives warranty countdown chips in lists + detail."
            />
            <InspectorInput
              label="Warn within (days)"
              value={String(field.options.warnWithinDays ?? '')}
              mono
              readOnly={readOnly}
              onChange={(v) => {
                const n = parseInt(v || '0', 10);
                const { warnWithinDays: _unused, ...rest } = field.options as Record<
                  string,
                  unknown
                >;
                void _unused;
                onChange({
                  options: {
                    ...rest,
                    ...(Number.isFinite(n) && n > 0 ? { warnWithinDays: n } : {}),
                  },
                });
              }}
            />
          </div>
        </InspectorField>
      );
    case 'ASSET_REFERENCE': {
      const currentTargetId = String(
        (field.options as { targetLayoutId?: string }).targetLayoutId ?? '',
      );
      // Surface all non-archived layouts, sorted by name for quick scanning.
      // The current layout is still included — self-reference is a valid
      // modeling choice (e.g. parent/child relationships on the same kind).
      // If the persisted target points to an archived layout we inject a
      // disabled row so the operator can see what they have without us
      // silently losing the value.
      const selectable = allLayouts
        .filter((l) => !l.archivedAt)
        .sort((a, b) => a.name.localeCompare(b.name));
      const persistedMissing =
        currentTargetId &&
        !selectable.some((l) => l.id === currentTargetId)
          ? allLayouts.find((l) => l.id === currentTargetId)
          : undefined;
      return (
        <InspectorField
          label="Reference target"
          hint="Pick the layout that assets of this field will point at."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <InspectorField label="Target layout">
              <select
                value={currentTargetId}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({
                    options: {
                      ...field.options,
                      targetLayoutId: e.target.value,
                    },
                  })
                }
                className="inp"
                style={inspectorInputStyle}
              >
                <option value="">— Select a layout —</option>
                {selectable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.id === currentLayoutId ? ' (this layout)' : ''}
                  </option>
                ))}
                {persistedMissing && (
                  <option value={persistedMissing.id}>
                    {persistedMissing.name} (archived)
                  </option>
                )}
              </select>
            </InspectorField>
            <InspectorInput
              label="Relation verb"
              value={String((field.options as { relationType?: string }).relationType ?? '')}
              mono
              readOnly={readOnly}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, relationType: v.trim() || undefined },
                })
              }
              help="Defaults to the field slug if blank."
            />
            <ToggleRow
              label="Allow multiple targets"
              value={!!(field.options as { multiple?: boolean }).multiple}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, multiple: v },
                })
              }
              disabled={readOnly}
            />
          </div>
        </InspectorField>
      );
    }
    case 'IP_ADDRESS':
      return (
        <InspectorField
          label="IP options"
          hint="Restrict the accepted family and decide whether CIDR suffixes (e.g. /24) are allowed."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <InspectorField label="Version">
              <select
                value={
                  (field.options as { version?: 'v4' | 'v6' | 'any' }).version ??
                  'any'
                }
                disabled={readOnly}
                onChange={(e) =>
                  onChange({
                    options: {
                      ...field.options,
                      version: e.target.value as 'v4' | 'v6' | 'any',
                    },
                  })
                }
                className="inp"
                style={inspectorInputStyle}
              >
                <option value="any">Any (IPv4 or IPv6)</option>
                <option value="v4">IPv4 only</option>
                <option value="v6">IPv6 only</option>
              </select>
            </InspectorField>
            <ToggleRow
              label="Allow CIDR suffix"
              value={!!(field.options as { allowCidr?: boolean }).allowCidr}
              onChange={(v) =>
                onChange({ options: { ...field.options, allowCidr: v } })
              }
              disabled={readOnly}
              help="Enables subnet entries like 10.0.0.0/24 alongside host addresses."
            />
          </div>
        </InspectorField>
      );
    case 'FILE':
      return (
        <InspectorField label="Upload">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <InspectorInput
              label="Max size (MB)"
              value={String((field.options as { maxSizeMb?: number }).maxSizeMb ?? 25)}
              mono
              readOnly={readOnly}
              onChange={(v) => {
                const n = parseInt(v || '0', 10);
                onChange({
                  options: {
                    ...field.options,
                    maxSizeMb: Number.isFinite(n) && n > 0 ? n : 25,
                  },
                });
              }}
            />
            <ToggleRow
              label="Allow multiple files"
              value={!!(field.options as { multiple?: boolean }).multiple}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, multiple: v },
                })
              }
              disabled={readOnly}
            />
          </div>
        </InspectorField>
      );
    default:
      return null;
  }
}

function ChoicesEditor({
  options,
  onChange,
  readOnly,
  allowAllowOther,
  allowMax,
}: {
  options: Record<string, unknown>;
  onChange: (opts: Record<string, unknown>) => void;
  readOnly: boolean;
  allowAllowOther?: boolean;
  allowMax?: boolean;
}) {
  const choices = (options.choices ?? []) as Array<{ label: string; slug: string; id: string }>;
  const [activeId, setActiveId] = useState<string | null>(null);

  // Ensure each choice has a stable id for drag-and-drop
  const choicesWithIds = useMemo(() => {
    return choices.map((c, i) => ({
      ...c,
      id: c.id || `choice-${i}-${randomClientId()}`,
    }));
  }, [choices]);

  // Sync ids back to choices array when they change
  useEffect(() => {
    const needsUpdate = choices.some((c, i) => !c.id || c.id !== choicesWithIds[i]?.id);
    if (needsUpdate) {
      onChange({ ...options, choices: choicesWithIds });
    }
  }, [choicesWithIds, choices, options, onChange]);

  function mutate(next: typeof choicesWithIds) {
    onChange({ ...options, choices: next });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id.toString());
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveId(null);
    if (!over || active.id === over.id) return;

    const oldIndex = choicesWithIds.findIndex((c) => c.id === active.id);
    const newIndex = choicesWithIds.findIndex((c) => c.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      mutate(arrayMove(choicesWithIds, oldIndex, newIndex));
    }
  }

  return (
    <InspectorField label="Options">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={choicesWithIds.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {choicesWithIds.map((c, i) => (
              <SortableChoiceRow
                key={c.id}
                choice={c}
                index={i}
                readOnly={readOnly}
                onChange={(updated) => {
                  const next = [...choicesWithIds];
                  next[i] = updated;
                  mutate(next);
                }}
                onRemove={() => mutate(choicesWithIds.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeId ? (
            <ChoiceRowOverlay
              choice={choicesWithIds.find((c) => c.id === activeId)!}
              index={choicesWithIds.findIndex((c) => c.id === activeId)}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      {!readOnly && (
        <button
          type="button"
          onClick={() => mutate([...choicesWithIds, { label: '', slug: '', id: `new-${Date.now()}` }])}
          style={{
            padding: '6px 8px',
            border: '1px dashed var(--line-2)',
            borderRadius: 3,
            fontSize: 11.5,
            fontFamily: 'var(--font-mono)',
            color: 'var(--dim)',
            textAlign: 'left',
            background: 'transparent',
            cursor: 'pointer',
            marginTop: 4,
          }}
        >
          + add option
        </button>
      )}
      {allowAllowOther && (
        <div style={{ marginTop: 8 }}>
          <ToggleRow
            label='Allow "Other" free text'
            value={!!options.allowOther}
            onChange={(v) => onChange({ ...options, allowOther: v })}
            disabled={readOnly}
          />
        </div>
      )}
      {allowMax && (
        <div style={{ marginTop: 4 }}>
          <InspectorInput
            label="Max selections"
            value={String((options as { maxSelections?: number }).maxSelections ?? '')}
            mono
            readOnly={readOnly}
            onChange={(v) => {
              const n = parseInt(v || '0', 10);
              const { maxSelections: _unused, ...rest } = options as Record<string, unknown>;
              void _unused;
              onChange(
                Number.isFinite(n) && n > 0
                  ? { ...rest, maxSelections: n }
                  : rest,
              );
            }}
          />
        </div>
      )}
    </InspectorField>
  );
}

function SortableChoiceRow({
  choice,
  index,
  readOnly,
  onChange,
  onRemove,
}: {
  choice: { label: string; slug: string; id: string };
  index: number;
  readOnly: boolean;
  onChange: (c: { label: string; slug: string; id: string }) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: choice.id, disabled: readOnly });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        padding: '6px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        borderRadius: 3,
        fontSize: 12,
        minWidth: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div
        {...(readOnly ? {} : attributes)}
        {...(readOnly ? {} : listeners)}
        style={{ cursor: readOnly ? 'default' : 'grab', display: 'grid', placeItems: 'center', flexShrink: 0 }}
        aria-label="Drag to reorder"
      >
        <Icon.grip size={10} style={{ color: 'var(--dim)' }} />
      </div>
      <input
        value={choice.label}
        readOnly={readOnly}
        placeholder={`Option ${index + 1}`}
        onChange={(e) => onChange({ ...choice, label: e.target.value })}
        onBlur={(e) => {
          if (!choice.slug) {
            onChange({ ...choice, label: e.target.value, slug: slugify(e.target.value) });
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          width: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--text)',
          fontSize: 12,
          fontFamily: 'inherit',
        }}
      />
      <input
        value={choice.slug}
        readOnly={readOnly}
        placeholder={`option_${index + 1}`}
        onChange={(e) => onChange({ ...choice, slug: slugify(e.target.value) })}
        style={{
          width: 80,
          minWidth: 0,
          flexShrink: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--dim)',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          textAlign: 'right',
        }}
      />
      {!readOnly && (
        <button
          type="button"
          onClick={onRemove}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--dim)',
            cursor: 'pointer',
          }}
          aria-label="Remove option"
        >
          <Icon.x size={10} />
        </button>
      )}
    </div>
  );
}

function ChoiceRowOverlay({
  choice,
  index,
}: {
  choice: { label: string; slug: string; id: string };
  index: number;
}) {
  return (
    <div
      style={{
        padding: '6px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--panel-2)',
        border: '1px solid var(--accent-line)',
        borderRadius: 3,
        fontSize: 12,
        minWidth: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
        boxShadow: '0 8px 22px -6px color-mix(in oklch, var(--accent) 30%, transparent)',
        opacity: 0.95,
      }}
    >
      <Icon.grip size={10} style={{ color: 'var(--dim)', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
        {choice.label || `Option ${index + 1}`}
      </span>
      <span
        style={{
          width: 80,
          minWidth: 0,
          flexShrink: 0,
          color: 'var(--dim)',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          textAlign: 'right',
        }}
      >
        {choice.slug || `option_${index + 1}`}
      </span>
      <Icon.x size={10} style={{ color: 'var(--dim)' }} />
    </div>
  );
}
