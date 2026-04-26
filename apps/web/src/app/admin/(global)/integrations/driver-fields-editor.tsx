'use client';

import type { DriverFieldDescriptor } from '@weavestream/shared';
import { Field, Input, Select } from '../../../../components/ui';

/**
 * Phase 11 — generic editor for the driver-advertised config / secret
 * fields. Used by both the create dialog and the per-integration
 * edit panel. Renders a `DriverFieldDescriptor` array with the right
 * input type and forwards every change up to the parent's setState
 * dictionary.
 */
export function DriverFieldsEditor({
  title,
  help,
  fields,
  values,
  onChange,
  isSecret = false,
}: {
  title: string;
  help?: string;
  fields: DriverFieldDescriptor[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  isSecret?: boolean;
}) {
  function set<K extends string>(key: K, value: unknown) {
    onChange({ ...values, [key]: value });
  }

  return (
    <fieldset
      style={{
        border: '1px solid var(--line-2)',
        borderRadius: 6,
        padding: 14,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        background: 'var(--panel)',
      }}
    >
      <legend
        style={{
          padding: '0 6px',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}
      >
        {title}
      </legend>
      {help && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{help}</p>
      )}
      {fields.map((f) => (
        <Field
          key={f.key}
          label={`${f.label}${f.required ? ' *' : ''}`}
          htmlFor={`df-${f.key}`}
          help={f.description ?? undefined}
        >
          {renderControl(f, values[f.key], (v) => set(f.key, v), isSecret)}
        </Field>
      ))}
    </fieldset>
  );
}

function renderControl(
  f: DriverFieldDescriptor,
  value: unknown,
  onChange: (v: unknown) => void,
  isSecret: boolean,
): React.ReactElement {
  if (f.kind === 'select') {
    return (
      <Select
        id={`df-${f.key}`}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select…</option>
        {(f.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (f.kind === 'boolean') {
    return (
      <Select
        id={`df-${f.key}`}
        value={value === undefined ? '' : String(value)}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : e.target.value === 'true')
        }
      >
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (f.kind === 'number') {
    return (
      <Input
        id={`df-${f.key}`}
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
      />
    );
  }
  return (
    <Input
      id={`df-${f.key}`}
      type={f.kind === 'password' ? 'password' : f.kind === 'url' ? 'url' : 'text'}
      autoComplete={isSecret ? 'new-password' : 'off'}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      placeholder={f.default !== undefined ? String(f.default) : undefined}
    />
  );
}
