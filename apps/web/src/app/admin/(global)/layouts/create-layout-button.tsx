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
  Icon,
  LayoutSwatch,
  useToast,
} from '../../../../components/ui';
import { LayoutFormFields, slugify } from './layout-form-fields';

type Step = 'pick' | 'details';

/**
 * Sentinel stored in the `templateId` state so "Start from scratch" is
 * distinguishable from "no choice made yet" (which would keep us on
 * the picker step). `null` = nothing selected, `''` = scratch.
 */
const SCRATCH: string = '';

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
          <LayoutFormFields
            values={{ name, slug, icon, color }}
            error={error}
            banner={
              templateId && templateId !== SCRATCH ? (
                <TemplateBanner
                  templateName={
                    getLayoutTemplate(templateId)?.name ?? null
                  }
                  color={color}
                />
              ) : null
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

function TemplateBanner({
  templateName,
  color,
}: {
  templateName: string | null;
  color: string;
}) {
  if (!templateName) return null;
  return (
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
      Starting from{' '}
      <strong style={{ color: 'var(--text)' }}>{templateName}</strong>
      <span style={{ color: 'var(--dim)' }}>— fields appear in the builder</span>
    </div>
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

