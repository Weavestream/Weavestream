'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  FIELD_TYPE_CATALOG,
  type FieldType,
  type FieldTypeMeta,
} from '@weavestream/shared';
import type { LayoutSummary } from '../../../../../lib/server-api';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Icon, LayoutSwatch, Tag, useToast } from '../../../../../components/ui';
import { TopBar } from '../../../../../components/shell/top-bar';
import { useTerm } from '../../../../../lib/term-context';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import {
  FileDropzone,
  type FileFieldEntry,
} from '../../../../../components/upload/file-dropzone';
import { AssetReferencePicker } from './asset-reference-picker';

// Lazy-load the Tiptap editor so its ~hundreds-of-KB bundle (and the
// accompanying `editor.css`) is only fetched when a `RICH_TEXT` field is
// actually rendered. Static imports cause Next.js to emit a CSS
// `<link rel="preload">` at page load; on asset types without a
// RICH_TEXT field the preloaded CSS goes unused and the browser warns
// ("preloaded but not used within a few seconds"). SSR is disabled
// because the editor is client-only anyway.
const RichTextEditor = dynamic(
  () =>
    import('../../../../../components/editor/rich-text-editor').then(
      (m) => m.RichTextEditor,
    ),
  { ssr: false },
);

/**
 * Dynamic asset form. Renders one input per active field in the given
 * layout, following the two-column grid defined in the design template
 * (`FieldTypeMeta.width`). `RICH_TEXT` mounts the Tiptap editor and
 * `FILE` mounts the MinIO-backed upload control.
 */

type Mode = 'create' | 'edit';

export function AssetForm({
  companyId,
  companyLabel,
  layout,
  mode,
  assetId,
  initialName,
  initialValues,
  onPickLayout,
}: {
  companyId: string;
  companyLabel: string;
  layout: LayoutSummary;
  mode: Mode;
  assetId?: string;
  initialName?: string | null;
  initialValues?: Record<string, unknown>;
  /** When provided (create mode), renders a "Change layout" affordance. */
  onPickLayout?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const activeFields = useMemo(
    () =>
      layout.fields
        .filter((f) => !f.archivedAt)
        .sort((a, b) => a.position - b.position),
    [layout.fields],
  );
  const primaryField = activeFields.find((f) => f.isPrimary) ?? activeFields[0];

  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of activeFields) {
      init[f.slug] =
        initialValues && f.slug in initialValues
          ? initialValues[f.slug]
          : defaultValueFor(f.fieldType);
    }
    return init;
  });
  const [name, setName] = useState<string>(initialName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  function update(slug: string, v: unknown) {
    setValues((cur) => ({ ...cur, [slug]: v }));
    setIssues((cur) => {
      if (!(slug in cur)) return cur;
      const next = { ...cur };
      delete next[slug];
      return next;
    });
  }

  async function submit() {
    setError(null);
    setIssues({});

    // Drop empty values so the API normalises them to null uniformly.
    const payloadValues: Record<string, unknown> = {};
    for (const f of activeFields) {
      const v = values[f.slug];
      if (v === undefined) continue;
      if (v === '' || (Array.isArray(v) && v.length === 0)) {
        payloadValues[f.slug] = null;
      } else {
        payloadValues[f.slug] = v;
      }
    }

    setSaving(true);
    if (mode === 'create') {
      const body = {
        assetLayoutId: layout.id,
        name: name.trim() || undefined,
        fieldValues: payloadValues,
      };
      const res = await apiFetch<{ id: string }>(
        `/companies/${companyId}/assets`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      setSaving(false);
      if (!res.ok || !res.data) {
        handleApiError(res.problem);
        return;
      }
      toast.push('Asset created', 'ok');
      router.push(`/admin/companies/${companyId}/assets/${res.data.id}`);
      router.refresh();
    } else {
      const body = {
        name: name.trim() || undefined,
        fieldValues: payloadValues,
      };
      const res = await apiFetch(
        `/companies/${companyId}/assets/${assetId!}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      setSaving(false);
      if (!res.ok) {
        handleApiError(res.problem);
        return;
      }
      toast.push('Asset saved', 'ok');
      router.push(`/admin/companies/${companyId}/assets/${assetId!}`);
      router.refresh();
    }
  }

  function handleApiError(problem: unknown) {
    // RFC 7807 extension members (see ProblemExceptionFilter): `detail`
    // stays a short string; `error`, `issues`, `slug`, etc. live at the
    // top level alongside it.
    const p = problem as
      | {
          detail?: string;
          title?: string;
          error?: string;
          issues?: Array<{ path: string; message: string }>;
          slug?: string;
          message?: string;
        }
      | undefined;
    if (p?.issues && Array.isArray(p.issues)) {
      const byPath: Record<string, string> = {};
      for (const iss of p.issues) {
        const key = iss.path.split('.')[0] ?? iss.path;
        byPath[key] = iss.message;
      }
      setIssues(byPath);
      setError('Fix the highlighted fields and try again.');
      return;
    }
    if (p?.error === 'UniqueFieldViolation' && p.slug) {
      setIssues({ [p.slug]: p.message ?? 'Value already used.' });
      setError(p.message ?? 'A uniqueness constraint failed.');
      return;
    }
    setError(p?.detail ?? p?.title ?? 'Save failed.');
  }

  return (
    <>
      <TopBar
        crumbs={companyCrumbs(
          term,
          { id: companyId, name: companyLabel },
          { label: 'Assets', href: `/admin/companies/${companyId}/assets` },
          ...(mode === 'create'
            ? ([{ label: 'New', mono: true }] as const)
            : ([
                { label: initialName ?? 'Asset' },
                { label: 'edit', mono: true },
              ] as const)),
        )}
        right={
          <>
            <Btn
              kind="outline"
              onClick={() => {
                if (mode === 'edit' && assetId) {
                  router.push(`/admin/companies/${companyId}/assets/${assetId}`);
                } else {
                  router.push(`/admin/companies/${companyId}/assets`);
                }
              }}
              disabled={saving}
            >
              Cancel
            </Btn>
            <Btn
              kind="primary"
              icon={Icon.check}
              loading={saving}
              onClick={submit}
            >
              {mode === 'create' ? 'Create asset' : 'Save asset'}
            </Btn>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          style={{
            padding: '10px 24px',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            borderBottom: '1px solid var(--line)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '24px 24px 40px',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: '100%', maxWidth: 780 }}>
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              marginBottom: 20,
            }}
          >
            <LayoutSwatch icon={layout.icon} color={layout.color} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{layout.name}</div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {activeFields.length} field{activeFields.length === 1 ? '' : 's'} ·
                v{layout.version} · global template
              </div>
            </div>
            {onPickLayout && (
              <Btn size="sm" kind="outline" onClick={onPickLayout} disabled={saving}>
                Change layout
              </Btn>
            )}
          </div>

          <h1
            style={{
              fontSize: 20,
              fontWeight: 550,
              margin: '0 0 18px',
              letterSpacing: -0.3,
            }}
          >
            {mode === 'create' ? (
              <>
                New {layout.name}{' '}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
                  · {companyLabel}
                </span>
              </>
            ) : (
              <>
                Edit{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  {initialName}
                </span>
              </>
            )}
          </h1>

          <div
            className="form-grid-2col"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 16,
            }}
          >
            {activeFields.map((f) => {
              const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === f.fieldType)!;
              const isPrimary = primaryField?.id === f.id;
              const colSpan: CSSProperties =
                meta.width === 'full' ? { gridColumn: '1 / -1' } : {};
              return (
                <div key={f.id} style={colSpan}>
                  <FormField
                    label={f.name}
                    required={f.isRequired}
                    visibleToClients={f.visibleToClients}
                    error={issues[f.slug]}
                  >
                    <FieldInput
                      field={f}
                      meta={meta}
                      value={values[f.slug]}
                      onChange={(v) => update(f.slug, v)}
                      disabled={saving}
                      companyId={companyId}
                      assetId={assetId}
                    />
                  </FormField>
                </div>
              );
            })}
          </div>

          {primaryField && (
            <div
              style={{
                marginTop: 18,
                padding: '10px 14px',
                background: 'var(--panel)',
                border: '1px dashed var(--line-2)',
                borderRadius: 5,
                fontSize: 11.5,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              Asset name auto-derives from{' '}
              <span style={{ color: 'var(--text-2)' }}>
                {primaryField.slug}
              </span>
              . Override it below if needed.
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <FormField label="Asset name override (optional)">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`Inherit from ${primaryField?.name ?? 'primary field'}`}
                disabled={saving}
                style={controlStyle}
              />
            </FormField>
          </div>
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// FormField + input dispatch
// ────────────────────────────────────────────────────────────────────

const controlStyle: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line-2)',
  borderRadius: 4,
  padding: '7px 10px',
  fontSize: 13,
  color: 'var(--text)',
  outline: 'none',
  width: '100%',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

function FormField({
  label,
  required,
  visibleToClients,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  visibleToClients?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {label}
        </span>
        {required && (
          <span style={{ color: 'var(--warn)', fontSize: 10 }}>required</span>
        )}
        {visibleToClients === false && <Tag tone="outline">internal</Tag>}
      </div>
      {children}
      {error ? (
        <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>
      ) : null}
    </div>
  );
}

function defaultValueFor(kind: FieldType): unknown {
  switch (kind) {
    case 'BOOLEAN':
      return false;
    case 'MULTISELECT':
    case 'TAGS':
      return [];
    case 'ASSET_REFERENCE':
      return null;
    default:
      return '';
  }
}

function FieldInput({
  field,
  meta,
  value,
  onChange,
  disabled,
  companyId,
  assetId,
}: {
  field: LayoutSummary['fields'][number];
  meta: FieldTypeMeta;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  companyId: string;
  assetId?: string;
}) {
  const mono = { fontFamily: 'var(--font-mono)' };
  switch (field.fieldType) {
    case 'TEXT':
    case 'EMAIL':
    case 'URL':
    case 'PHONE':
    case 'VAULTWARDEN_LINK':
    case 'IP_ADDRESS':
      return (
        <input
          value={(value as string | null) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{
            ...controlStyle,
            ...(field.fieldType === 'EMAIL' ||
            field.fieldType === 'URL' ||
            field.fieldType === 'PHONE' ||
            field.fieldType === 'VAULTWARDEN_LINK' ||
            field.fieldType === 'IP_ADDRESS'
              ? mono
              : {}),
          }}
          placeholder={placeholderFor(field.fieldType, field.options)}
          inputMode={field.fieldType === 'IP_ADDRESS' ? 'numeric' : undefined}
          autoCapitalize={field.fieldType === 'IP_ADDRESS' ? 'none' : undefined}
          autoCorrect={field.fieldType === 'IP_ADDRESS' ? 'off' : undefined}
          spellCheck={field.fieldType === 'IP_ADDRESS' ? false : undefined}
          type={
            field.fieldType === 'EMAIL'
              ? 'email'
              : field.fieldType === 'URL' || field.fieldType === 'VAULTWARDEN_LINK'
                ? 'url'
                : field.fieldType === 'PHONE'
                  ? 'tel'
                  : 'text'
          }
        />
      );
    case 'TEXTAREA':
      return (
        <textarea
          value={(value as string | null) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          style={{ ...controlStyle, padding: 10, minHeight: 80 }}
          placeholder="Type here…"
        />
      );
    case 'RICH_TEXT':
      return (
        <div
          style={{
            ...controlStyle,
            padding: 8,
            minHeight: 100,
            overflow: 'hidden',
          }}
        >
          <RichTextEditor
            variant="field"
            value={value}
            onChange={(next) => onChange(next)}
            editable={!disabled}
            companyId={companyId}
            placeholder="Rich text — type / for blocks, @ to link an asset or article"
          />
        </div>
      );
    case 'NUMBER':
      return (
        <input
          type="number"
          value={value == null ? '' : (value as number | string)}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? '' : Number(v));
          }}
          style={{ ...controlStyle, ...mono }}
        />
      );
    case 'DATE':
      return (
        <input
          type="date"
          value={(value as string | null) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...controlStyle, ...mono }}
        />
      );
    case 'DATETIME':
      return (
        <input
          type="datetime-local"
          value={((value as string | null) ?? '').slice(0, 16)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...controlStyle, ...mono }}
        />
      );
    case 'BOOLEAN':
      return (
        <label
          style={{
            ...controlStyle,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={!!value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span style={{ fontSize: 13 }}>{value ? 'True' : 'False'}</span>
        </label>
      );
    case 'DROPDOWN': {
      const choices = ((field.options as { choices?: Array<{ slug: string; label: string }> })
        .choices ?? []) as Array<{ slug: string; label: string }>;
      return (
        <select
          value={(value as string | null) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          style={controlStyle}
        >
          <option value="">— select —</option>
          {choices.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.label}
            </option>
          ))}
        </select>
      );
    }
    case 'MULTISELECT': {
      const choices = ((field.options as { choices?: Array<{ slug: string; label: string }> })
        .choices ?? []) as Array<{ slug: string; label: string }>;
      const current = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div
          style={{
            ...controlStyle,
            padding: 6,
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            minHeight: 32,
          }}
        >
          {choices.map((c) => {
            const active = current.includes(c.slug);
            return (
              <button
                key={c.slug}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange(
                    active
                      ? current.filter((s) => s !== c.slug)
                      : [...current, c.slug],
                  )
                }
                style={{
                  padding: '3px 8px',
                  fontSize: 11.5,
                  borderRadius: 3,
                  border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line-2)'}`,
                  background: active ? 'var(--accent-soft)' : 'var(--panel-2)',
                  color: active ? 'var(--accent)' : 'var(--text-2)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      );
    }
    case 'TAGS': {
      const tags = Array.isArray(value) ? (value as string[]) : [];
      return (
        <TagsInput
          value={tags}
          onChange={(next) => onChange(next)}
          disabled={disabled}
        />
      );
    }
    case 'ASSET_REFERENCE': {
      const opts = field.options as {
        multiple?: boolean;
        targetLayoutId?: string | null;
      };
      return (
        <AssetReferencePicker
          companyId={companyId}
          currentAssetId={assetId}
          targetLayoutId={opts.targetLayoutId ?? null}
          multiple={!!opts.multiple}
          value={value}
          onChange={(next) => onChange(next)}
          disabled={disabled}
          controlStyle={controlStyle}
        />
      );
    }
    case 'FILE': {
      const entries: FileFieldEntry[] = Array.isArray(value)
        ? (value as FileFieldEntry[])
        : [];
      const multiple = (field.options as { multiple?: boolean }).multiple ?? true;
      return (
        <FileDropzone
          companyId={companyId}
          value={entries}
          multiple={multiple}
          disabled={disabled}
          attachTo={
            assetId
              ? { type: 'asset', id: assetId }
              : { type: 'asset' }
          }
          onChange={(next) =>
            onChange(multiple ? next : next.slice(-1))
          }
        />
      );
    }
    default:
      return (
        <input
          value={(value as string | null) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          style={controlStyle}
        />
      );
  }
}

function TagsInput({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  function commit() {
    const t = draft.trim();
    if (!t) return;
    if (value.includes(t)) {
      setDraft('');
      return;
    }
    onChange([...value, t]);
    setDraft('');
  }
  return (
    <div
      style={{
        ...controlStyle,
        padding: 6,
        display: 'flex',
        gap: 5,
        flexWrap: 'wrap',
        alignItems: 'center',
        minHeight: 32,
      }}
    >
      {value.map((t) => (
        <Tag key={t} tone="outline" style={{ height: 20 }}>
          {t}
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(value.filter((v) => v !== t))}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
                marginLeft: 3,
              }}
              aria-label={`Remove tag ${t}`}
            >
              <Icon.x size={9} />
            </button>
          )}
        </Tag>
      ))}
      <input
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder="add tag…"
        style={{
          flex: 1,
          minWidth: 90,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          fontSize: 12.5,
          color: 'var(--text)',
          padding: '4px 2px',
        }}
      />
    </div>
  );
}

function placeholderFor(
  kind: FieldType,
  options?: Record<string, unknown>,
): string {
  switch (kind) {
    case 'EMAIL':
      return 'name@domain.com';
    case 'URL':
      return 'https://…';
    case 'PHONE':
      return '+1 555 123 4567';
    case 'VAULTWARDEN_LINK':
      return 'https://vault.example.local/...';
    case 'IP_ADDRESS': {
      const version = (options as { version?: 'v4' | 'v6' | 'any' } | undefined)
        ?.version;
      const allowCidr = !!(options as { allowCidr?: boolean } | undefined)
        ?.allowCidr;
      const v4 = allowCidr ? '10.0.0.0/24' : '10.0.0.5';
      const v6 = allowCidr ? '2001:db8::/48' : '2001:db8::1';
      if (version === 'v4') return v4;
      if (version === 'v6') return v6;
      return `${v4} or ${v6}`;
    }
    default:
      return '';
  }
}
