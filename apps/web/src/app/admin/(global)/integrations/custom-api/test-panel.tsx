'use client';

import { useState } from 'react';
import {
  CUSTOM_API_LIMITS,
  type CustomApiTestRecord,
  type CustomApiTestResponse,
  type CustomApiTestSection,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  DataTable,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Select,
  Tag,
  type DataColumn,
} from '../../../../../components/ui';
import { safeIntegrationProblemMessage } from '../integration-feedback';
import { cleanDefinition, type CustomApiDraft } from './definition-draft';
import { usePathTarget } from './path-input';

const MASK = '••••';

type Row = CustomApiTestRecord & { id: string; recordId: string | null };

/**
 * **Test** for one section of a draft definition: reads 1 page through
 * the API's Test route and shows parsed records and the first record's
 * key list. A saved integration uses `:id/custom-api/test` (the saved
 * secret is used unless `secret` is given); the create dialog uses
 * `custom-api/draft-test` with the typed secret. Errors are the
 * server's fixed text: never upstream body text.
 */
export function TestPanel({
  integrationId,
  definition,
  section,
  secret,
  orgId,
  disabledReason,
  onResult,
}: {
  integrationId: string | null;
  definition: CustomApiDraft;
  section: CustomApiTestSection;
  /** The full secret bundle to test with; omitted means the saved one (or none). */
  secret?: Record<string, string>;
  /** Endpoint mode, resource sections only. */
  orgId?: string;
  /** Why Test cannot run now; null when it can. */
  disabledReason: string | null;
  onResult?: (result: CustomApiTestResponse | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CustomApiTestResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setRequestError(null);
    const body = {
      definition: cleanDefinition(definition),
      section,
      ...(orgId ? { orgId } : {}),
      ...(secret && Object.keys(secret).length > 0 ? { secret } : {}),
    };
    const path = integrationId
      ? `/admin/integrations/${integrationId}/custom-api/test`
      : '/admin/integrations/custom-api/draft-test';
    const fail = (message: string) => {
      setResult(null);
      onResult?.(null);
      setRequestError(message);
    };
    try {
      const res = await apiFetch<CustomApiTestResponse>(path, { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok || !res.data) {
        fail(
          res.status === 429
            ? 'Too many tests. Wait a minute, then test again.'
            : safeIntegrationProblemMessage(res.problem, 'The test failed. Try again.', secret ?? {}),
        );
        return;
      }
      setResult(res.data);
      onResult?.(res.data);
    } catch {
      // A network failure: the error object can carry request details, so
      // show fixed text only.
      fail('Could not reach Weavestream. Check the connection, then test again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Btn kind="outline" size="sm" icon={Icon.zap} onClick={run} loading={pending} disabled={disabledReason !== null}>
          Test
        </Btn>
        {disabledReason && <span style={noteStyle}>{disabledReason}</span>}
      </div>
      {requestError && <Tag tone="danger">{requestError}</Tag>}
      {result && !result.ok && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Tag tone="danger">
            {result.message}
            {result.status !== null ? ` (${result.status})` : ''}
          </Tag>
          <span style={noteStyle}>Reference: {result.correlationId}</span>
        </div>
      )}
      {result?.ok && <TestResult result={result} />}
    </div>
  );
}

function TestResult({ result }: { result: Extract<CustomApiTestResponse, { ok: true }> }) {
  const organizations = result.section === 'organizations';
  const noun = organizations
    ? result.recordCount === 1 ? 'organization' : 'organizations'
    : result.recordCount === 1 ? 'record' : 'records';
  const rows: Row[] = result.records.map((record, index) => ({ ...record, id: String(index), recordId: record.id }));
  const fieldColumns = result.records[0]?.fields ?? [];
  const columns: DataColumn<Row>[] = [
    { id: 'name', header: 'Name', width: 180, render: (r) => r.name ?? <Missing /> },
    { id: 'id', header: 'Id', width: 140, mono: true, render: (r) => r.recordId ?? <Missing /> },
    ...(organizations
      ? []
      : [{ id: 'match', header: 'Match value', width: 160, mono: true, render: (r: Row) => r.match ?? '—' }]),
    ...fieldColumns.map((f, index) => ({
      id: `field-${f.key}`,
      header: f.label,
      width: 160,
      render: (r: Row) => <FieldValue field={r.fields[index]} />,
    })),
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-2)' }}>
        {result.recordCount} {noun} on the first page. More pages: {result.hasMore ? 'yes' : 'no'}.
      </p>
      {rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={rows}
          disableSort
          renderMobileCard={(r) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>{r.name ?? 'No name'}</span>
              <MobileCardRow label="Id" mono>{r.recordId ?? '—'}</MobileCardRow>
              {!organizations && <MobileCardRow label="Match value" mono>{r.match ?? '—'}</MobileCardRow>}
              {r.fields.map((f) => (
                <MobileCardRow key={f.key} label={f.label}>
                  <FieldValue field={f} />
                </MobileCardRow>
              ))}
            </div>
          )}
        />
      )}
      {result.keys.length > 0 && <KeyList keys={result.keys} />}
    </div>
  );
}

function FieldValue({ field }: { field: CustomApiTestRecord['fields'][number] | undefined }) {
  if (!field) return <>—</>;
  if (field.warning === 'missing') return <Tag tone="warn">no value</Tag>;
  if (field.warning === 'not_scalar') return <Tag tone="warn">not a single value</Tag>;
  return <>{field.value ?? '—'}</>;
}

function Missing() {
  return <Tag tone="warn">no value</Tag>;
}

function KeyList({ keys }: { keys: Extract<CustomApiTestResponse, { ok: true }>['keys'] }) {
  const writePath = usePathTarget();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={noteStyle}>
        Keys in the first record. Click a key to put its path in the last path input you selected.
      </span>
      {note && <span style={noteStyle}>{note}</span>}
      <ul
        role="list"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--line)',
          borderRadius: 6,
          maxHeight: 260,
          overflowY: 'auto',
        }}
      >
        {keys.map((key) => (
          <li key={key.path} style={{ borderBottom: '1px solid var(--line)' }}>
            <button
              type="button"
              onClick={() => setNote(writePath(key.path) ? `Set to ${key.path}.` : 'Select a path input first, then click a key.')}
              style={keyButtonStyle}
            >
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', overflowWrap: 'anywhere' }}>{key.path}</span>
              <span style={{ color: 'var(--dim)' }}>{key.type}</span>
              <span style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>{key.masked ? MASK : (key.sample ?? 'null')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The organization a resource Test reads in endpoint mode: picked from the
 * last Organizations Test, or typed. Masked or cut samples are not offered,
 * because they are not the real id.
 */
export function TestOrgPicker({
  id,
  organizations,
  value,
  onChange,
}: {
  id: string;
  organizations: CustomApiTestRecord[];
  value: string;
  onChange: (next: string) => void;
}) {
  const usable = organizations.filter(
    (org): org is CustomApiTestRecord & { id: string } =>
      org.id !== null && org.id !== MASK && org.id.length < CUSTOM_API_LIMITS.testSampleLength,
  );
  const hidden = organizations.length - usable.length;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
      {usable.length > 0 && (
        <Field label="Test with organization" htmlFor={`${id}-pick`} style={{ flex: '1 1 200px' }}>
          <Select
            id={`${id}-pick`}
            value={usable.some((org) => org.id === value) ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">Pick an organization</option>
            {usable.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name ? `${org.name} (${org.id})` : org.id}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label="Organization id"
        htmlFor={`${id}-manual`}
        help={
          hidden > 0
            ? `${hidden} organization ids were hidden or cut in the Test result. Type the id.`
            : usable.length === 0
              ? 'Test Organizations to pick one, or type the id.'
              : undefined
        }
        style={{ flex: '1 1 200px' }}
      >
        <Input
          id={`${id}-manual`}
          value={value}
          autoComplete="off"
          style={{ fontFamily: 'var(--font-mono)' }}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    </div>
  );
}

const noteStyle: React.CSSProperties = { fontSize: 12, color: 'var(--muted)' };

const keyButtonStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 2fr) 60px minmax(0, 3fr)',
  gap: 10,
  width: '100%',
  minHeight: 36,
  padding: '6px 10px',
  border: 0,
  background: 'transparent',
  textAlign: 'left',
  fontSize: 12,
  cursor: 'pointer',
};
