'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createAssetLayoutSchema } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Input,
  LayoutSwatch,
  useToast,
} from '../../../../components/ui';
import type { IconComponent, IconName } from '../../../../components/ui/icon';

const ICON_CHOICES = [
  'laptop',
  'server',
  'network',
  'box',
  'globe',
  'person',
  'building',
  'key',
  'doc',
  'shield',
];

const COLOR_CHOICES = [
  { label: 'Blue', value: 'var(--info)' },
  { label: 'Amber', value: 'var(--warn)' },
  { label: 'Purple', value: '#c084fc' },
  { label: 'Green', value: 'var(--ok)' },
  { label: 'Pink', value: '#f472b6' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Sky', value: '#60a5fa' },
  { label: 'Slate', value: 'var(--muted)' },
];

export function CreateLayoutButton() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [icon, setIcon] = useState<string>('laptop');
  const [color, setColor] = useState<string>('var(--info)');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setName('');
    setSlug('');
    setSlugTouched(false);
    setIcon('laptop');
    setColor('var(--info)');
    setError(null);
  }

  function slugify(s: string) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 48);
  }

  async function submit() {
    setError(null);
    const parsed = createAssetLayoutSchema.safeParse({ name, slug, icon, color });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the fields above.');
      return;
    }
    setPending(true);
    const res = await apiFetch<{ id: string }>('/layouts', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as { title?: string; detail?: string } | undefined;
      setError(problem?.detail ?? problem?.title ?? 'Could not create layout.');
      return;
    }
    toast.push(`Created ${parsed.data.name}`, 'ok');
    setOpen(false);
    reset();
    router.push(`/admin/layouts/${res.data.id}/edit`);
    router.refresh();
  }

  return (
    <>
      <Btn kind="primary" size="md" icon={Icon.plus} onClick={() => setOpen(true)}>
        New layout
      </Btn>
      <Dialog
        open={open}
        onClose={() => {
          if (!pending) {
            setOpen(false);
            reset();
          }
        }}
        title="Create layout"
        footer={
          <>
            <Btn
              kind="ghost"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={pending}
            >
              Cancel
            </Btn>
            <Btn kind="primary" onClick={submit} loading={pending}>
              Create & open builder
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              padding: '10px 12px',
              background: 'var(--panel-2)',
              border: '1px solid var(--line)',
              borderRadius: 6,
            }}
          >
            <LayoutSwatch icon={icon} color={color} size={36} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {name || 'Untitled layout'}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--dim)',
                }}
              >
                /{slug || 'slug'}
              </div>
            </div>
          </div>

          <Field label="Name" htmlFor="layout-name">
            <Input
              id="layout-name"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="Workstation"
            />
          </Field>

          <Field
            label="Slug"
            htmlFor="layout-slug"
            help="Lowercase snake_case. Used in URLs and filter DSL."
          >
            <Input
              id="layout-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value.toLowerCase());
                setSlugTouched(true);
              }}
              style={{ fontFamily: 'var(--font-mono)' }}
              placeholder="workstation"
            />
          </Field>

          <Field label="Icon">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {ICON_CHOICES.map((k) => {
                const selected = icon === k;
                const IconCmp = Icon[k as IconName] as IconComponent | undefined;
                if (!IconCmp) return null;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setIcon(k)}
                    aria-pressed={selected}
                    aria-label={k}
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 6,
                      display: 'grid',
                      placeItems: 'center',
                      background: selected
                        ? `color-mix(in oklch, ${color} 14%, transparent)`
                        : 'var(--panel)',
                      border: `1px solid ${
                        selected
                          ? `color-mix(in oklch, ${color} 55%, transparent)`
                          : 'var(--line-2)'
                      }`,
                      color: selected ? color : 'var(--muted)',
                      cursor: 'pointer',
                      transition: 'background 120ms, border-color 120ms, color 120ms',
                    }}
                  >
                    <IconCmp size={18} />
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Color" error={error ?? undefined}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {COLOR_CHOICES.map((c) => {
                const selected = color === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setColor(c.value)}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 4,
                      border: `1px solid ${selected ? c.value : 'var(--line-2)'}`,
                      background: selected
                        ? `color-mix(in oklch, ${c.value} 14%, transparent)`
                        : 'var(--panel)',
                      color: selected ? c.value : 'var(--muted)',
                      fontSize: 12,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: c.value,
                      }}
                    />
                    {c.label}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      </Dialog>
    </>
  );
}
