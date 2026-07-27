import { cardMetaParts, formatCompactValue } from './card-fields';
import { makeAsset, makeLayout, makeLayoutField } from './test-fixtures';

const TZ = 'UTC';

describe('cardMetaParts', () => {
  it('projects isPrimary || showInTable fields in position order', () => {
    const layout = makeLayout();
    const asset = makeAsset({
      name: 'srv-pines-01',
      fieldValues: { hostname: 'core-sw-01', mgmt_ip: '10.20.0.5' },
    });
    // hostname (primary) then mgmt_ip (showInTable); runbook (RICH_TEXT,
    // not in table) is never a candidate.
    expect(cardMetaParts(asset, layout, TZ)).toEqual(['core-sw-01', '10.20.0.5']);
  });

  it('dedupes the part equal to the asset name (primary usually IS the name)', () => {
    const layout = makeLayout();
    const asset = makeAsset(); // name === fieldValues.hostname === 'srv-pines-01'
    expect(cardMetaParts(asset, layout, TZ)).toEqual(['10.20.0.5']);
  });

  it('skips value-less slugs (empty or role-filtered)', () => {
    const layout = makeLayout();
    const asset = makeAsset({ fieldValues: {} });
    expect(cardMetaParts(asset, layout, TZ)).toEqual([]);
  });

  it('skips archived layout fields', () => {
    const layout = makeLayout({
      fields: [
        makeLayoutField({ slug: 'hostname', isPrimary: true, position: 0 }),
        makeLayoutField({
          slug: 'old_col',
          showInTable: true,
          position: 1,
          archivedAt: '2026-06-01T00:00:00.000Z',
        }),
      ],
    });
    const asset = makeAsset({
      name: 'x',
      fieldValues: { hostname: 'host-1', old_col: 'stale' },
    });
    expect(cardMetaParts(asset, layout, TZ)).toEqual(['host-1']);
  });

  it('falls back to the primary field from asset.fields when the layout is undefined', () => {
    const asset = makeAsset({
      name: 'x',
      fieldValues: { hostname: 'host-1', mgmt_ip: '10.0.0.1' },
    });
    // Only the primary — showInTable is unknowable without the layout.
    expect(cardMetaParts(asset, undefined, TZ)).toEqual(['host-1']);
  });

  it('caps at 4 parts', () => {
    const fields = Array.from({ length: 6 }, (_, i) =>
      makeLayoutField({ slug: `f${i}`, showInTable: true, position: i }),
    );
    const layout = makeLayout({ fields });
    const asset = makeAsset({
      name: 'x',
      fieldValues: Object.fromEntries(fields.map((f, i) => [f.slug, `v${i}`])),
    });
    expect(cardMetaParts(asset, layout, TZ)).toHaveLength(4);
  });
});

describe('formatCompactValue', () => {
  const refs = {};
  const field = (fieldType: string, options: Record<string, unknown> = {}) => ({
    fieldType,
    name: 'Monitored',
    options,
    slug: 'x',
  });

  it('renders empty values as null', () => {
    expect(formatCompactValue(field('TEXT'), null, refs, TZ)).toBeNull();
    expect(formatCompactValue(field('TEXT'), undefined, refs, TZ)).toBeNull();
    expect(formatCompactValue(field('TEXT'), '', refs, TZ)).toBeNull();
  });

  it('excludes RICH_TEXT / FILE / VAULTWARDEN_LINK entirely', () => {
    expect(formatCompactValue(field('RICH_TEXT'), { type: 'doc' }, refs, TZ)).toBeNull();
    expect(formatCompactValue(field('FILE'), [{ uploadId: 'u' }], refs, TZ)).toBeNull();
    expect(formatCompactValue(field('VAULTWARDEN_LINK'), { url: 'https://x' }, refs, TZ)).toBeNull();
  });

  it('BOOLEAN true reads as the field name; false is skipped', () => {
    expect(formatCompactValue(field('BOOLEAN'), true, refs, TZ)).toBe('Monitored');
    expect(formatCompactValue(field('BOOLEAN'), false, refs, TZ)).toBeNull();
  });

  it('DROPDOWN resolves the slug to its label, raw slug as fallback', () => {
    const opts = { choices: [{ slug: 'prod', label: 'Production' }] };
    expect(formatCompactValue(field('DROPDOWN', opts), 'prod', refs, TZ)).toBe('Production');
    expect(formatCompactValue(field('DROPDOWN', opts), 'legacy_value', refs, TZ)).toBe('legacy_value');
  });

  it('MULTISELECT shows two labels plus overflow', () => {
    const opts = {
      choices: [
        { slug: 'a', label: 'Alpha' },
        { slug: 'b', label: 'Beta' },
        { slug: 'c', label: 'Gamma' },
      ],
    };
    expect(formatCompactValue(field('MULTISELECT', opts), ['a', 'b', 'c'], refs, TZ)).toBe(
      'Alpha, Beta +1',
    );
  });

  it('TAGS uses hydrated names', () => {
    const value = [{ id: 't1', name: 'noc' }, { id: 't2', name: 'critical' }];
    expect(formatCompactValue(field('TAGS'), value, refs, TZ)).toBe('noc, critical');
  });

  it('ASSET_REFERENCE resolves names from the sidecar with the missing fallback', () => {
    const references = {
      'aaaaaaaa-0000-4000-8000-000000000001': {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        name: 'core-sw-01',
        archivedAt: null,
      },
    };
    const value = [
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000002',
    ];
    expect(formatCompactValue(field('ASSET_REFERENCE'), value, references, TZ)).toBe(
      'core-sw-01, bbbbbbbb… (missing)',
    );
  });

  it('DATE pins to the calendar day (UTC), DATETIME formats in the viewer zone', () => {
    expect(formatCompactValue(field('DATE'), '2026-03-14', refs, TZ)).toBe('Mar 14, 2026');
    expect(formatCompactValue(field('DATETIME'), '2026-03-14T10:00:00Z', refs, TZ)).toBe(
      'Mar 14, 2026',
    );
  });

  it('TEXTAREA shows only the first line', () => {
    expect(formatCompactValue(field('TEXTAREA'), 'line one\nline two', refs, TZ)).toBe('line one');
  });

  it('unknown types degrade to String for scalars and null for structures', () => {
    expect(formatCompactValue(field('FUTURE_TYPE'), 42, refs, TZ)).toBe('42');
    expect(formatCompactValue(field('FUTURE_TYPE'), { nested: true }, refs, TZ)).toBeNull();
  });
});
