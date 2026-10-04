'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
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
import { randomClientId } from '@weavestream/shared/browser';
import { Icon } from '../../../../../../../components/ui';
import { slugifyFieldSlug as slugify } from '../../../../../../../lib/slugify';
import { InspectorField, InspectorInput, ToggleRow } from './inspector-controls';

export function ChoicesEditor({
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
