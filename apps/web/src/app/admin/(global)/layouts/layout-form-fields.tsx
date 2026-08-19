'use client';

import { Field, Icon, Input, LayoutSwatch } from '../../../../components/ui';
import type { IconComponent, IconName } from '../../../../components/ui/icon';

/**
 * Shared name/slug/icon/color editor used by both the create-layout
 * dialog and the post-create settings dialog. Keeping the visual
 * language identical means operators learn the controls once and the
 * rename flow doesn't feel like a second UI.
 */

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
  'folder',
  'tag',
  'clock',
  'image',
  'gear',
  'home',
] as const;

const COLOR_CHOICES: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Blue', value: 'var(--info)' },
  { label: 'Amber', value: 'var(--warn)' },
  { label: 'Purple', value: '#c084fc' },
  { label: 'Green', value: 'var(--ok)' },
  { label: 'Pink', value: '#f472b6' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Sky', value: '#60a5fa' },
  { label: 'Slate', value: 'var(--muted)' },
  // Theme-aware --layout-* tokens (light + dark ramps live in
  // styles/tokens.css). Coral/Indigo previously hardcoded hex, so a
  // saved layout wouldn't adapt between light and dark; Teal's token
  // shipped with no matching choice at all. Wiring all three keeps the
  // swatch consistent with the Blue/Amber/Green/Slate var() choices.
  { label: 'Teal', value: 'var(--layout-teal)' },
  { label: 'Coral', value: 'var(--layout-coral)' },
  { label: 'Indigo', value: 'var(--layout-indigo)' },
];

export { slugifyLayoutSlug as slugify } from '../../../../lib/slugify';

export type LayoutFormValues = {
  name: string;
  slug: string;
  icon: string;
  color: string;
};

export function LayoutFormFields({
  values,
  error,
  onName,
  onSlug,
  onIcon,
  onColor,
  banner,
  slugHelp = 'Lowercase snake_case. Used in URLs and filter DSL.',
  slugWarning,
  namePlaceholder = 'Workstation',
  slugPlaceholder = 'workstation',
}: {
  values: LayoutFormValues;
  error: string | null;
  onName: (v: string) => void;
  onSlug: (v: string) => void;
  onIcon: (v: string) => void;
  onColor: (v: string) => void;
  /** Optional lead-in slot, e.g. the "Starting from <template>" chip. */
  banner?: React.ReactNode;
  slugHelp?: string;
  slugWarning?: string | null;
  namePlaceholder?: string;
  slugPlaceholder?: string;
}) {
  const { name, slug, icon, color } = values;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {banner}

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
          onChange={(e) => onName(e.target.value)}
          placeholder={namePlaceholder}
        />
      </Field>

      <Field label="Slug" htmlFor="layout-slug" help={slugHelp}>
        <Input
          id="layout-slug"
          value={slug}
          onChange={(e) => onSlug(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)' }}
          placeholder={slugPlaceholder}
        />
        {slugWarning && (
          <div
            role="note"
            style={{
              marginTop: 8,
              padding: '8px 10px',
              fontSize: 11.5,
              lineHeight: 1.45,
              color: 'var(--warn)',
              background: 'color-mix(in oklch, var(--warn) 10%, transparent)',
              border: '1px solid color-mix(in oklch, var(--warn) 35%, transparent)',
              borderRadius: 5,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
            }}
          >
            <Icon.warn size={12} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{slugWarning}</span>
          </div>
        )}
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
                onClick={() => onIcon(k)}
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
                  transition:
                    'background 120ms, border-color 120ms, color 120ms',
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
                onClick={() => onColor(c.value)}
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
  );
}
