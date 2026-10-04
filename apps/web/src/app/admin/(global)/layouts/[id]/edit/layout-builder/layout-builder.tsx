'use client';

import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { LayoutStats, LayoutSummary } from '@weavestream/shared';
import { useRouter } from 'next/navigation';
import { lower } from '../../../../../../../lib/term';
import { useTerm } from '../../../../../../../lib/term-context';
import {
  Btn,
  Icon,
  MenuDivider,
  MenuItem,
  OverflowMenu,
  Tag,
} from '../../../../../../../components/ui';
import { TopBar } from '../../../../../../../components/shell/top-bar';
import { useIsMobile } from '../../../../../../../lib/hooks/use-is-mobile';
import { LayoutSettingsDialog } from '../../../layout-settings-dialog';
import { LayoutArchiveDialog } from '../../../layout-archive-dialog';
import { CanvasDropzone, FieldRowOverlay, SortableFieldRow } from './canvas-rows';
import { FieldInspector } from './field-inspector';
import { FieldTypePalette, PaletteChip } from './field-type-palette';
import { countTableColumns } from './layout-builder-state';
import { MobileLayoutPreview } from './mobile-layout-preview';
import { useLayoutBuilder } from './use-layout-builder';

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
  const term = useTerm();
  const isMobile = useIsMobile();
  const builder = useLayoutBuilder({ layout, canEdit });
  const {
    fields,
    selectedKey,
    selected,
    drag,
    dirty,
    saving,
    error,
    forcePrompt,
    save,
  } = builder;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const isArchived = layout.archivedAt !== null;

  if (isMobile) {
    return (
      <MobileLayoutPreview
        layout={layout}
        stats={stats}
        activeFields={builder.activeFields}
      />
    );
  }

  const tableColumnCount = countTableColumns(fields);

  const headerDescription = (
    <>
      v{layout.version} · {fields.length} field{fields.length === 1 ? '' : 's'}
      {stats &&
        ` · used by ${stats.assetCount} asset${stats.assetCount === 1 ? '' : 's'} in ${stats.companyCount} ${
          stats.companyCount === 1 ? lower(term.one) : lower(term.other)
        }`}
    </>
  );

  /**
   * The editor's controls, rendered into `TopBar`'s `right` slot.
   *
   * Same shape as the article editor (`article-form.tsx`): Cancel and
   * the primary stay visible — Cancel is the escape hatch and must
   * never hide in a menu — while Settings and Archive move into the
   * overflow. The four-button shelf and the 50px row it sat in are
   * gone, which is height the field canvas gets back.
   *
   * A reader gets the `read only` tag and nothing else. No overflow
   * trigger: every row it could hold is a mutation behind `canEdit`,
   * and an empty menu is worse than no menu.
   */
  const headerActions = canEdit ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {/* The layout's blast radius — version, field count, how many
          assets ride on it. Least load-bearing thing in the row, so it
          is what gives up its seat first (see `.hide-on-narrow`). */}
      <span
        className="hide-on-narrow"
        style={{
          paddingRight: 2,
          color: 'var(--dim)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          whiteSpace: 'nowrap',
        }}
      >
        {headerDescription}
      </span>
      {isArchived && <Tag tone="warn">archived</Tag>}
      {!isArchived && dirty && <Tag tone="warn">unsaved</Tag>}
      <Btn
        kind="outline"
        size="md"
        onClick={() => router.push('/admin/layouts')}
        disabled={saving}
      >
        Cancel
      </Btn>
      {isArchived ? (
        // Fields can't be saved while archived, so the primary slot
        // carries the action that makes them editable again rather
        // than sitting empty.
        <Btn
          kind="solid"
          size="md"
          icon={Icon.check}
          onClick={() => setArchiveOpen(true)}
          disabled={saving}
        >
          Restore
        </Btn>
      ) : (
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
      <OverflowMenu>
        {(close) => (
          <>
            <MenuItem
              icon={Icon.edit}
              disabled={saving}
              onClick={() => {
                setSettingsOpen(true);
                close();
              }}
            >
              Settings
            </MenuItem>
            {!isArchived && <MenuDivider />}
            {!isArchived && (
              <MenuItem
                icon={Icon.archive}
                disabled={saving}
                onClick={() => {
                  setArchiveOpen(true);
                  close();
                }}
              >
                Archive
              </MenuItem>
            )}
          </>
        )}
      </OverflowMenu>
    </div>
  ) : (
    <Tag tone="outline">read only</Tag>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TopBar
        crumbs={[
          { label: 'Layouts', href: '/admin/layouts' },
          { label: layout.name },
          { label: 'edit', mono: true },
        ]}
        // One row, not two. The trail already names the layout, and an
        // editing surface spends its height on the canvas rather than
        // on restating the record above it — same call the article
        // editor makes.
        right={headerActions}
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
          <Btn kind="ghost" size="sm" onClick={builder.dismissForcePrompt}>
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
        sensors={builder.sensors}
        collisionDetection={closestCenter}
        onDragStart={builder.onDragStart}
        onDragEnd={builder.onDragEnd}
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
                      onSelect={() => builder.select(f.key)}
                      onRemove={() => builder.removeField(f.key)}
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
              onChange={(patch) => selected && builder.updateField(selected.key, patch)}
              onSlugAutoFill={(label) => {
                if (selected) builder.autoFillSlug(selected.key, label);
              }}
              onMakePrimary={builder.setPrimary}
              allLayouts={allLayouts}
              currentLayoutId={layout.id}
            />
          </div>
        </div>

        <DragOverlay>
          {drag?.kind === 'palette' ? <PaletteChip kind={drag.fieldType} overlay /> : null}
          {drag?.kind === 'field'
            ? (() => {
                const f = fields.find((x) => x.key === drag.key);
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
