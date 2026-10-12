import { INTEGRATION_SECTION_LIMITS, integrationSectionSchema } from './integration-section.js';
import { driverResourceDescriptorSchema } from './integration.js';

const row = { label: 'Status', kind: 'text', value: 'Active' };
function section(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Workspace',
    groups: [{ key: 'account', title: 'Account', icon: 'gmail', rows: [row] }],
    ...overrides,
  };
}
function withRows(rows: unknown[]) {
  return section({ groups: [{ key: 'g', title: 'G', rows }] });
}
const ok = (value: unknown) => integrationSectionSchema.safeParse(value).success;

describe('integrationSectionSchema', () => {
  it('accepts every row kind', () => {
    expect(ok(withRows([
      { label: 'a', kind: 'text', value: 'x' },
      { label: 'b', kind: 'number', value: 3 },
      { label: 'c', kind: 'bytes', value: 1024 },
      { label: 'd', kind: 'date', value: '2026-10-01' },
      { label: 'e', kind: 'datetime', value: '2026-10-01T10:00:00.000Z' },
      { label: 'f', kind: 'boolean', value: false },
      { label: 'g', kind: 'badge', value: 'Suspended', tone: 'danger' },
      { label: 'h', kind: 'link', value: 'https://example.com/admin', text: 'Console' },
      { label: 'i', kind: 'list', value: ['a', 'b'] },
      { label: 'j', kind: 'meter', used: 12.4, total: 30, unit: 'mb' },
    ]))).toBe(true);
  });

  it('rejects unknown kinds and unknown keys', () => {
    expect(ok(withRows([{ label: 'a', kind: 'html', value: '<b>x</b>' }]))).toBe(false);
    expect(ok(withRows([{ ...row, html: 'x' }]))).toBe(false);
    expect(ok(section({ extra: true }))).toBe(false);
  });

  it.each(['<script>alert(1)</script>', '<img src=x onerror=1>', '</div>', '<!-- x -->', 'line\u0000break'])(
    'rejects markup or control characters (%s)',
    (value) => {
      expect(ok(withRows([{ label: 'a', kind: 'text', value }]))).toBe(false);
      expect(ok(section({ title: value }))).toBe(false);
    },
  );

  it('allows plain comparison text', () => {
    expect(ok(withRows([{ label: 'a', kind: 'text', value: 'used < quota' }]))).toBe(true);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', '//example.com'])(
    'rejects non-http(s) links (%s)',
    (value) => {
      expect(ok(withRows([{ label: 'a', kind: 'link', value }]))).toBe(false);
    },
  );

  it('enforces the size caps', () => {
    const groups = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `g${i}`, title: 'G', rows: [] }));
    expect(ok(section({ groups: groups(INTEGRATION_SECTION_LIMITS.groups) }))).toBe(true);
    expect(ok(section({ groups: groups(INTEGRATION_SECTION_LIMITS.groups + 1) }))).toBe(false);
    expect(ok(withRows(Array.from({ length: INTEGRATION_SECTION_LIMITS.rowsPerGroup + 1 }, () => row)))).toBe(false);
    expect(ok(withRows([{ label: 'a', kind: 'list', value: Array.from({ length: INTEGRATION_SECTION_LIMITS.listItems + 1 }, () => 'x') }]))).toBe(false);
    expect(ok(withRows([{ label: 'a', kind: 'text', value: 'x'.repeat(INTEGRATION_SECTION_LIMITS.textLength + 1) }]))).toBe(false);
  });

  it('rejects duplicate group keys, unknown icons and bad meters', () => {
    expect(ok(section({ groups: [{ key: 'a', title: 'A', rows: [] }, { key: 'a', title: 'B', rows: [] }] }))).toBe(false);
    expect(ok(section({ icon: '../../etc/passwd' }))).toBe(false);
    expect(ok(withRows([{ label: 'm', kind: 'meter', used: 1, total: 0, unit: 'mb' }]))).toBe(false);
    expect(ok(withRows([{ label: 'm', kind: 'meter', used: -1, total: 10, unit: 'mb' }]))).toBe(false);
    expect(ok(withRows([{ label: 'n', kind: 'number', value: Number.NaN }]))).toBe(false);
  });
});

describe('driverResourceDescriptorSchema match suggestions', () => {
  it('accepts matchSuggestions and minimalFields', () => {
    const parsed = driverResourceDescriptorSchema.parse({
      key: 'users',
      label: 'Users',
      matchSuggestions: { sourceField: 'primaryEmail', layoutHints: ['people'], fieldHints: ['email'] },
      minimalFields: ['fullName', 'primaryEmail'],
    });
    expect(parsed.matchSuggestions?.sourceField).toBe('primaryEmail');
  });

  it('rejects unknown keys in matchSuggestions', () => {
    expect(driverResourceDescriptorSchema.safeParse({
      key: 'users',
      label: 'Users',
      matchSuggestions: { sourceField: 'x', layoutHints: [], fieldHints: [], extra: 1 },
    }).success).toBe(false);
  });
});
