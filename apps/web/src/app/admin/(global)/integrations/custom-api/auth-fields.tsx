'use client';

import type { CustomApiAuthMethod } from '@weavestream/shared';
import { Field, Input, RadioOption, Select } from '../../../../../components/ui';
import { emptyAuth, type CustomApiDraftAuth, type DraftIssues } from './definition-draft';

const METHODS: Array<{ value: CustomApiAuthMethod; label: string; hint: string }> = [
  { value: 'bearer', label: 'Bearer token', hint: 'Authorization: Bearer <token>' },
  { value: 'header', label: 'API key header', hint: 'The key in a header you name.' },
  { value: 'basic', label: 'User name and password', hint: 'HTTP Basic authentication.' },
  { value: 'oauth_client_credentials', label: 'OAuth client credentials', hint: 'A client ID and secret get a short-lived token.' },
  { value: 'none', label: 'No authentication', hint: 'The API needs no credentials.' },
];

/**
 * The authentication method and its non-secret fields. Secret values are
 * entered separately (see `CustomApiSecretInputs`) and never stored in
 * the definition.
 */
export function AuthFields({
  idPrefix,
  value,
  onChange,
  issues,
  dense = false,
}: {
  idPrefix: string;
  value: CustomApiDraftAuth;
  onChange: (next: CustomApiDraftAuth) => void;
  issues: DraftIssues;
  dense?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Method</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
          {METHODS.map((m) => (
            <RadioOption
              key={m.value}
              name={`${idPrefix}-auth-method`}
              checked={value.method === m.value}
              onChange={() => {
                if (value.method !== m.value) onChange(emptyAuth(m.value));
              }}
              label={m.label}
              hint={m.hint}
              dense={dense}
            />
          ))}
        </div>
      </fieldset>
      {value.method === 'header' && (
        <Field label="Header name" htmlFor={`${idPrefix}-auth-header`} error={issues.get('auth.headerName')} help="For example X-API-Key.">
          <Input
            id={`${idPrefix}-auth-header`}
            value={value.headerName}
            autoComplete="off"
            onChange={(e) => onChange({ ...value, headerName: e.target.value })}
          />
        </Field>
      )}
      {value.method === 'basic' && (
        <Field label="User name" htmlFor={`${idPrefix}-auth-user`} error={issues.get('auth.username')}>
          <Input
            id={`${idPrefix}-auth-user`}
            value={value.username}
            autoComplete="off"
            onChange={(e) => onChange({ ...value, username: e.target.value })}
          />
        </Field>
      )}
      {value.method === 'oauth_client_credentials' && (
        <>
          <Field
            label="Token URL"
            htmlFor={`${idPrefix}-auth-token-url`}
            error={issues.get('auth.tokenUrl')}
            help="HTTPS. It can be on another host than the Base URL."
          >
            <Input
              id={`${idPrefix}-auth-token-url`}
              type="url"
              value={value.tokenUrl}
              autoComplete="off"
              onChange={(e) => onChange({ ...value, tokenUrl: e.target.value })}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Field label="Scope" htmlFor={`${idPrefix}-auth-scope`} error={issues.get('auth.scope')} help="Optional.">
              <Input
                id={`${idPrefix}-auth-scope`}
                value={value.scope ?? ''}
                autoComplete="off"
                onChange={(e) => onChange({ ...value, scope: e.target.value })}
              />
            </Field>
            <Field label="Send the client credentials" htmlFor={`${idPrefix}-auth-client`}>
              <Select
                id={`${idPrefix}-auth-client`}
                value={value.clientAuth ?? 'body'}
                onChange={(e) => onChange({ ...value, clientAuth: e.target.value as 'body' | 'basic' })}
              >
                <option value="body">In the request body</option>
                <option value="basic">As Basic authentication</option>
              </Select>
            </Field>
          </div>
        </>
      )}
    </div>
  );
}

export const fieldsetStyle: React.CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 };

export const legendStyle: React.CSSProperties = {
  padding: 0,
  marginBottom: 6,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
};
