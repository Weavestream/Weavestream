'use client';

import { useState } from 'react';
import { CUSTOM_API_LIMITS } from '@weavestream/shared';
import { Btn, Field, Icon, Input, Select, Textarea } from '../../../../../components/ui';
import {
  DuplicateQueryNames,
  InvalidJsonBody,
  emptyPagination,
  type DraftIssues,
  type DraftPagination,
  type DraftRequest,
} from './definition-draft';
import { PathInput } from './path-input';

const PLACEHOLDER_HELP = 'Placeholders: {orgId}, {cursor}, {page}, {offset}, {limit}.';

/** Method, path, query parameters, and (POST only) a fixed JSON body. */
export function RequestFields({
  idPrefix,
  issuePath,
  value,
  onChange,
  issues,
}: {
  idPrefix: string;
  /** Joined schema path of this request, for example `resources.devices.request`. */
  issuePath: string;
  value: DraftRequest;
  onChange: (next: DraftRequest) => void;
  issues: DraftIssues;
}) {
  const [query, setRows] = useState(() => queryRows(value.query));
  // The query this form last showed or sent. A different one means the
  // definition was replaced (an import): show its rows. The admin's own
  // edits update `seen` first, so rows keep their order while typing.
  const [seen, setSeen] = useState<unknown>(value.query);
  if (value.query !== seen) {
    setSeen(value.query);
    setRows(queryRows(value.query));
  }
  const duplicates = value.query instanceof DuplicateQueryNames;
  const queryIssue = duplicates
    ? 'Two query parameters have the same name. Change one of them.'
    : [...issues].find(([key]) => key.startsWith(`${issuePath}.query`))?.[1];
  const setQuery = (rows: Array<[string, string]>) => {
    const names = rows.map(([name]) => name);
    const next =
      new Set(names).size === names.length
        ? Object.fromEntries(rows)
        : (new DuplicateQueryNames(rows) as unknown as Record<string, string>);
    setRows(rows);
    setSeen(next);
    onChange({ ...value, query: next });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={rowStyle}>
        <Field label="Method" htmlFor={`${idPrefix}-method`} style={{ flex: '0 0 110px' }}>
          <Select
            id={`${idPrefix}-method`}
            value={value.method ?? 'GET'}
            onChange={(e) => {
              // Only a POST request has a body: a switch to GET drops it.
              const { body: _body, ...rest } = value;
              onChange({ ...rest, method: e.target.value as 'GET' | 'POST' });
            }}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </Select>
        </Field>
        <Field
          label="Path"
          htmlFor={`${idPrefix}-path`}
          error={issues.get(`${issuePath}.path`)}
          help={`Joined to the Base URL. ${PLACEHOLDER_HELP}`}
          style={{ flex: '1 1 240px' }}
        >
          <Input
            id={`${idPrefix}-path`}
            value={value.path}
            placeholder="/api/v1/devices"
            spellCheck={false}
            autoComplete="off"
            style={{ fontFamily: 'var(--font-mono)' }}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
        </Field>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={subLabelStyle}>Query parameters</span>
        {query.map(([name, val], index) => (
          <div key={index} style={rowStyle}>
            <Input
              aria-label={`Query parameter ${index + 1} name`}
              value={name}
              placeholder="name"
              autoComplete="off"
              style={{ flex: '1 1 140px', fontFamily: 'var(--font-mono)' }}
              onChange={(e) => setQuery(query.map((row, i) => (i === index ? [e.target.value, row[1]] : row)))}
            />
            <Input
              aria-label={`Query parameter ${index + 1} value`}
              value={val}
              placeholder="{cursor}"
              autoComplete="off"
              style={{ flex: '2 1 180px', fontFamily: 'var(--font-mono)' }}
              onChange={(e) => setQuery(query.map((row, i) => (i === index ? [row[0], e.target.value] : row)))}
            />
            <Btn kind="ghost" size="sm" icon={Icon.trash} aria-label={`Remove query parameter ${index + 1}`} onClick={() => setQuery(query.filter((_, i) => i !== index))} />
          </div>
        ))}
        {queryIssue && <span role="alert" style={errorTextStyle}>{queryIssue}</span>}
        <div>
          <Btn
            kind="ghost"
            size="sm"
            icon={Icon.plus}
            disabled={query.length >= CUSTOM_API_LIMITS.queryParams || query.some(([name]) => name === '')}
            onClick={() => setQuery([...query, ['', '']])}
          >
            Add query parameter
          </Btn>
        </div>
      </div>
      {value.method === 'POST' && (
        <BodyField
          id={`${idPrefix}-body`}
          value={value.body}
          error={issues.get(`${issuePath}.body`)}
          onChange={(body) => onChange({ ...value, body })}
        />
      )}
    </div>
  );
}

function queryRows(query: unknown): Array<[string, string]> {
  if (query instanceof DuplicateQueryNames) return query.rows.map(([name, val]) => [name, val]);
  return Object.entries((query ?? {}) as Record<string, string>);
}

function bodyText(value: unknown): string {
  if (value instanceof InvalidJsonBody) return value.text;
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

function BodyField({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: unknown;
  error?: string;
  onChange: (next: unknown) => void;
}) {
  const [text, setText] = useState(() => bodyText(value));
  // The body this field last showed or sent. A different body means the
  // definition was replaced (an import): show the new body. The admin's
  // own typing updates `seen` first, so it keeps its own formatting.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(bodyText(value));
  }
  const emit = (next: unknown) => {
    setSeen(next);
    onChange(next);
  };
  return (
    <Field
      label="Body (JSON)"
      htmlFor={id}
      error={value instanceof InvalidJsonBody ? 'This is not valid JSON.' : error}
      help={`Fixed JSON. ${PLACEHOLDER_HELP} Placeholders go in string values only.`}
    >
      <Textarea
        id={id}
        value={text}
        rows={5}
        spellCheck={false}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next.trim() === '') {
            emit(undefined);
            return;
          }
          try {
            emit(JSON.parse(next) as unknown);
          } catch {
            emit(new InvalidJsonBody(next));
          }
        }}
      />
    </Field>
  );
}

const STYLES: Array<{ value: DraftPagination['style']; label: string }> = [
  { value: 'none', label: 'One request (no pages)' },
  { value: 'page', label: 'Page number' },
  { value: 'offset', label: 'Record offset' },
  { value: 'cursor', label: 'Cursor from the response' },
  { value: 'next_url', label: 'Next page URL in the response' },
  { value: 'link_header', label: 'Link header (rel="next")' },
];

/** The pagination style and its fields. Paths here are read from the whole response, not from a record. */
export function PaginationFields({
  idPrefix,
  issuePath,
  value,
  onChange,
  issues,
}: {
  idPrefix: string;
  issuePath: string;
  value: DraftPagination;
  onChange: (next: DraftPagination) => void;
  issues: DraftIssues;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Pages" htmlFor={`${idPrefix}-style`}>
        <Select
          id={`${idPrefix}-style`}
          value={value.style}
          onChange={(e) => onChange(emptyPagination(e.target.value as DraftPagination['style']))}
        >
          {STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      {(value.style === 'page' || value.style === 'offset' || value.style === 'cursor') && (
        <div style={rowStyle}>
          {value.style === 'page' && (
            <Field label="First page" htmlFor={`${idPrefix}-first`} style={{ flex: '0 0 110px' }}>
              <Select
                id={`${idPrefix}-first`}
                value={String(value.firstPage ?? 1)}
                onChange={(e) => onChange({ ...value, firstPage: Number(e.target.value) })}
              >
                <option value="1">1</option>
                <option value="0">0</option>
              </Select>
            </Field>
          )}
          <Field
            label={value.style === 'cursor' ? 'Page size (optional)' : 'Page size'}
            htmlFor={`${idPrefix}-size`}
            error={issues.get(`${issuePath}.pageSize`)}
            help="The value of {limit}."
            style={{ flex: '0 1 160px' }}
          >
            <Input
              id={`${idPrefix}-size`}
              type="number"
              min={1}
              max={CUSTOM_API_LIMITS.recordsPerPage}
              value={value.pageSize ?? ''}
              onChange={(e) =>
                onChange({ ...value, pageSize: e.target.value === '' ? undefined : Number(e.target.value) } as DraftPagination)
              }
            />
          </Field>
          {value.style !== 'cursor' && (
            <div style={{ flex: '1 1 200px' }}>
              <PathInput
                id={`${idPrefix}-total`}
                label="Total count path (optional)"
                value={value.totalPath ?? ''}
                error={issues.get(`${issuePath}.totalPath`)}
                help="Without it, a short page is the last page."
                onChange={(totalPath) => onChange({ ...value, totalPath })}
              />
            </div>
          )}
        </div>
      )}
      {value.style === 'cursor' && (
        <PathInput
          id={`${idPrefix}-cursor`}
          label="Cursor path"
          value={value.cursorPath}
          error={issues.get(`${issuePath}.cursorPath`)}
          help="Where the response holds the next cursor. Empty or missing ends the walk."
          onChange={(cursorPath) => onChange({ ...value, cursorPath })}
        />
      )}
      {value.style === 'next_url' && (
        <PathInput
          id={`${idPrefix}-next`}
          label="Next page URL path"
          value={value.nextUrlPath}
          error={issues.get(`${issuePath}.nextUrlPath`)}
          help="The URL must be on the Base URL host and path."
          onChange={(nextUrlPath) => onChange({ ...value, nextUrlPath })}
        />
      )}
    </div>
  );
}

export const rowStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' };

export const subLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
};

export const errorTextStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--danger)' };
