'use client';

import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FIELD_TYPE_CATALOG, canShowInTable } from '@weavestream/shared';
import { Btn, Icon, Tag } from '../../../../../../../components/ui';
import { CANVAS_DROPZONE_ID } from './layout-builder-state';
import type { BuilderField } from './types';

export function SortableFieldRow({
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

export function FieldRowOverlay({ field }: { field: BuilderField }) {
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

export function CanvasDropzone({ canEdit }: { canEdit: boolean }) {
  const { isOver, setNodeRef } = useDroppable({ id: CANVAS_DROPZONE_ID });
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
