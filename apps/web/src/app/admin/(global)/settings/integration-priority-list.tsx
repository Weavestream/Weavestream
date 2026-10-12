'use client';

import { useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { problemMessage, type IntegrationPriorityDto } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Btn, Icon, useToast } from '../../../../components/ui';
import { SectionHeader } from './settings-form';

type Entry = IntegrationPriorityDto['order'][number];

/** `list` with the item at `from` moved to `to`. */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * Integration priority order (Admin > Settings > Integrations). Native
 * drag and drop on wide screens, plus Up / Down buttons for keyboards,
 * screen readers and touch. Saving needs a fresh step-up (apiFetch
 * prompts); the new order applies from each integration's next sync.
 */
export function IntegrationPriorityList({ initial }: { initial: Entry[] }) {
  const router = useRouter();
  const toast = useToast();
  const [saved, setSaved] = useState(initial);
  const [order, setOrder] = useState(initial);
  const [dragging, setDragging] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = order.some((entry, index) => entry.key !== saved[index]?.key);

  function onDrop(event: DragEvent, to: number) {
    event.preventDefault();
    if (dragging !== null) setOrder((current) => moveEntry(current, dragging, to));
    setDragging(null);
  }

  async function save() {
    setPending(true);
    const res = await apiFetch('/settings/integration-priority', {
      method: 'PUT',
      body: JSON.stringify({ order: order.map((entry) => entry.key) }),
    });
    setPending(false);
    if (!res.ok) {
      if (!res.stepUpCancelled) toast.push(problemMessage(res.problem) ?? 'Could not save the integration order.', 'danger');
      return;
    }
    setSaved(order);
    toast.push('Integration order saved. It applies from the next sync.', 'ok');
    router.refresh();
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader
        label="Which integration's values win when several fill the same asset"
        help="When one person or device comes from several integrations, the highest one that has a value fills each standard field. Lower ones only fill empty fields and list any other value as a difference on the asset."
      />
      <ol aria-label="Integration priority, highest first" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
        {order.map((entry, index) => (
          <li
            key={entry.key}
            draggable
            onDragStart={() => setDragging(index)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, index)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              border: '1px solid var(--line)',
              borderRadius: 6,
              background: dragging === index ? 'var(--panel-2)' : 'var(--panel)',
              cursor: 'grab',
            }}
          >
            <span aria-hidden style={{ display: 'inline-flex', color: 'var(--muted)', flexShrink: 0 }}>
              <Icon.grip size={14} />
            </span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)', width: 18 }}>{index + 1}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text)', overflowWrap: 'anywhere' }}>{entry.label}</span>
            <Btn
              kind="ghost"
              size="sm"
              aria-label={`Move ${entry.label} up`}
              disabled={index === 0 || pending}
              onClick={() => setOrder((current) => moveEntry(current, index, index - 1))}
            >
              Up
            </Btn>
            <Btn
              kind="ghost"
              size="sm"
              aria-label={`Move ${entry.label} down`}
              disabled={index === order.length - 1 || pending}
              onClick={() => setOrder((current) => moveEntry(current, index, index + 1))}
            >
              Down
            </Btn>
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Btn kind="primary" onClick={() => void save()} loading={pending} disabled={!dirty || pending}>
          Save order
        </Btn>
        <Btn kind="outline" onClick={() => setOrder(saved)} disabled={!dirty || pending}>
          Reset
        </Btn>
      </div>
    </section>
  );
}
