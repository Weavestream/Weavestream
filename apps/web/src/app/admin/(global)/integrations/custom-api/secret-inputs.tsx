'use client';

import { customApiSecretKeyLabel } from '@weavestream/shared';
import { Field, Input } from '../../../../../components/ui';

/**
 * Write-only inputs for exactly the secret keys a definition needs (the
 * auth method's keys, then one per secret header). Values never come
 * back from the API; the saved bundle shows only as a mask.
 */
export function CustomApiSecretInputs({
  idPrefix,
  keys,
  values,
  onChange,
}: {
  idPrefix: string;
  keys: readonly string[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  if (keys.length === 0) {
    return <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>This definition uses no credentials.</p>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
      {keys.map((key, index) => {
        const id = `${idPrefix}-secret-${index}`;
        return (
          <Field key={key} label={`${customApiSecretKeyLabel(key)} *`} htmlFor={id}>
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={typeof values[key] === 'string' ? (values[key] as string) : ''}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
            />
          </Field>
        );
      })}
    </div>
  );
}
