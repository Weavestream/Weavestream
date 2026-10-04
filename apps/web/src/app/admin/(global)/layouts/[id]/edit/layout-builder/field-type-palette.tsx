'use client';

import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { FIELD_TYPE_CATALOG, type FieldType } from '@weavestream/shared';
import { Icon } from '../../../../../../../components/ui';
import { PALETTE_DRAG_PREFIX } from './layout-builder-state';

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

export function FieldTypePalette({ disabled }: { disabled: boolean }) {
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

export function PaletteChip({
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
    id: `${PALETTE_DRAG_PREFIX}${kind}`,
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
