'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LAYOUT_TEMPLATES,
  createAssetLayoutSchema,
  getLayoutTemplate,
  type LayoutTemplate,
} from '@weavestream/shared';
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

type Step = 'pick' | 'details';

/**
 * Sentinel stored in the `templateId` state so "Start from scratch" is
 * distinguishable from "no choice made yet" (which would keep us on
 * the picker step). `null` = nothing selected, `''` = scratch.
 */
const SCRATCH: string = '';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 48);
}

export function CreateLayoutButton() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('pick');
  // `null` until the user picks something on step 1; `SCRATCH` for the
  // from-scratch branch; a concrete id for a template pick.
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [icon, setIcon] = useState<string>('laptop');
  const [color, setColor] = useState<string>('var(--info)');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setStep('pick');
    setTemplateId(null);
    setName('');
    setSlug('');
    setSlugTouched(false);
    setIcon('laptop');
    setColor('var(--info)');
    setError(null);
  }

  /** Advance to step 2 and pre-seed name/slug/icon/color for a template. */
  function chooseTemplate(tpl: LayoutTemplate) {
    setTemplateId(tpl.id);
    setName(tpl.name);
    setSlug(tpl.suggestedSlug);
    // Treat the template-derived slug as "untouched" so the user renaming
    // the layout keeps the slug linked until they manually override it.
    setSlugTouched(false);
    setIcon(tpl.icon);
    setColor(tpl.color);
    setError(null);
    setStep('details');
  }

  /** Advance to step 2 with empty defaults. */
  function chooseScratch() {
    setTemplateId(SCRATCH);
    setName('');
    setSlug('');
    setSlugTouched(false);
    setIcon('laptop');
    setColor('var(--info)');
    setError(null);
    setStep('details');
  }

  function goBack() {
    if (pending) return;
    setStep('pick');
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
    const appliedTemplateId =
      templateId && templateId !== SCRATCH && getLayoutTemplate(templateId)
        ? templateId
        : null;
    const query = appliedTemplateId
      ? `?template=${encodeURIComponent(appliedTemplateId)}`
      : '';
    reset();
    router.push(`/admin/layouts/${res.data.id}/edit${query}`);
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
        title={step === 'pick' ? 'Create layout' : 'Name your layout'}
        width={step === 'pick' ? 640 : 420}
        footer={
          step === 'pick' ? (
            <Btn
              kind="ghost"
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Cancel
            </Btn>
          ) : (
            <>
              <Btn kind="ghost" onClick={goBack} disabled={pending}>
                Back
              </Btn>
              <Btn kind="primary" onClick={submit} loading={pending}>
                Create & open builder
              </Btn>
            </>
          )
        }
      >
        {step === 'pick' ? (
          <TemplatePicker
            onPickTemplate={chooseTemplate}
            onPickScratch={chooseScratch}
          />
        ) : (
          <DetailsForm
            name={name}
            slug={slug}
            icon={icon}
            color={color}
            error={error}
            slugTouched={slugTouched}
            selectedTemplateName={
              templateId && templateId !== SCRATCH
                ? getLayoutTemplate(templateId)?.name ?? null
                : null
            }
            onName={(v) => {
              setName(v);
              if (!slugTouched) setSlug(slugify(v));
            }}
            onSlug={(v) => {
              setSlug(v.toLowerCase());
              setSlugTouched(true);
            }}
            onIcon={setIcon}
            onColor={setColor}
          />
        )}
      </Dialog>
    </>
  );
}

function TemplatePicker({
  onPickTemplate,
  onPickScratch,
}: {
  onPickTemplate: (tpl: LayoutTemplate) => void;
  onPickScratch: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          color: 'var(--dim)',
          lineHeight: 1.5,
        }}
      >
        Pick a starter to pre-fill fields for common MSP asset types, or start
        from scratch with an empty layout.
      </p>

      <ScratchCard onClick={onPickScratch} />

      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--dim)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginTop: 4,
        }}
      >
        Start from a template
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 10,
        }}
      >
        {LAYOUT_TEMPLATES.map((tpl) => (
          <TemplateCard key={tpl.id} template={tpl} onClick={() => onPickTemplate(tpl)} />
        ))}
      </div>
    </div>
  );
}

function ScratchCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '12px 14px',
        background: 'var(--panel-2)',
        border: '1px dashed var(--line-2)',
        borderRadius: 8,
        cursor: 'pointer',
        textAlign: 'left',
        color: 'var(--text)',
        transition: 'border-color 120ms, background 120ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line-2)';
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 6,
          display: 'grid',
          placeItems: 'center',
          background: 'var(--panel)',
          border: '1px solid var(--line-2)',
          color: 'var(--muted)',
          flexShrink: 0,
        }}
      >
        <Icon.plus size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Start from scratch</div>
        <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
          Blank layout — you pick every field yourself.
        </div>
      </div>
      <Icon.chevron size={14} style={{ color: 'var(--dim)', flexShrink: 0 }} />
    </button>
  );
}

function TemplateCard({
  template,
  onClick,
}: {
  template: LayoutTemplate;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: 12,
        background: 'var(--panel-2)',
        border: '1px solid var(--line-2)',
        borderRadius: 8,
        cursor: 'pointer',
        textAlign: 'left',
        color: 'var(--text)',
        transition: 'border-color 120ms, background 120ms, transform 120ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `color-mix(in oklch, ${template.color} 55%, var(--line-2))`;
        e.currentTarget.style.background = `color-mix(in oklch, ${template.color} 6%, var(--panel-2))`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line-2)';
        e.currentTarget.style.background = 'var(--panel-2)';
      }}
    >
      <LayoutSwatch icon={template.icon} color={template.color} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {template.name}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--dim)',
            marginTop: 3,
            lineHeight: 1.4,
          }}
        >
          {template.description}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--muted)',
            marginTop: 6,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {template.fields.length} fields
        </div>
      </div>
    </button>
  );
}

function DetailsForm({
  name,
  slug,
  icon,
  color,
  error,
  selectedTemplateName,
  onName,
  onSlug,
  onIcon,
  onColor,
}: {
  name: string;
  slug: string;
  icon: string;
  color: string;
  error: string | null;
  slugTouched: boolean;
  selectedTemplateName: string | null;
  onName: (v: string) => void;
  onSlug: (v: string) => void;
  onIcon: (v: string) => void;
  onColor: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {selectedTemplateName && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            background: `color-mix(in oklch, ${color} 8%, transparent)`,
            border: `1px solid color-mix(in oklch, ${color} 35%, transparent)`,
            borderRadius: 6,
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          <Icon.check size={12} style={{ color }} />
          Starting from <strong style={{ color: 'var(--text)' }}>{selectedTemplateName}</strong>
          <span style={{ color: 'var(--dim)' }}>— fields appear in the builder</span>
        </div>
      )}

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
          onChange={(e) => onSlug(e.target.value)}
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
