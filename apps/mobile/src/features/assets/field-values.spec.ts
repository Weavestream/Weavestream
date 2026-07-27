import { ApiError } from '../../lib/api';
import {
  buildCreateAssetPayload,
  buildUpdateAssetPayload,
  invalidNumberSlugs,
  isKnownFieldType,
  isMobileEditableFieldType,
  mapAssetWriteError,
  missingRequiredSlugs,
  seedAssetForm,
  toWireValue,
  unsatisfiableRequiredFields,
  type AssetFormModel,
  type FieldEditorValue,
} from './field-values';
import { makeAsset, makeLayoutField } from './test-fixtures';
import type { LayoutFieldRecord } from './api';

/**
 * The crown jewels of Phase 2c: `persistFieldValues` deletes on
 * explicit null and preserves on omission, so every case here is a
 * data-integrity guarantee, not a style preference.
 */

const KITCHEN_SINK: LayoutFieldRecord[] = [
  makeLayoutField({ slug: 'hostname', fieldType: 'TEXT', isPrimary: true, position: 0 }),
  makeLayoutField({ slug: 'notes_area', fieldType: 'TEXTAREA', position: 1 }),
  makeLayoutField({ slug: 'runbook', fieldType: 'RICH_TEXT', position: 2 }),
  makeLayoutField({ slug: 'ram_gb', fieldType: 'NUMBER', position: 3 }),
  makeLayoutField({ slug: 'installed_on', fieldType: 'DATE', position: 4 }),
  makeLayoutField({ slug: 'last_boot', fieldType: 'DATETIME', position: 5 }),
  makeLayoutField({ slug: 'monitored', fieldType: 'BOOLEAN', position: 6 }),
  makeLayoutField({
    slug: 'env',
    fieldType: 'DROPDOWN',
    position: 7,
    options: { choices: [{ slug: 'prod', label: 'Production' }], allowOther: false },
  }),
  makeLayoutField({
    slug: 'roles',
    fieldType: 'MULTISELECT',
    position: 8,
    options: {
      choices: [
        { slug: 'dns', label: 'DNS' },
        { slug: 'dhcp', label: 'DHCP' },
      ],
    },
  }),
  makeLayoutField({ slug: 'contact_email', fieldType: 'EMAIL', position: 9 }),
  makeLayoutField({ slug: 'contact_phone', fieldType: 'PHONE', position: 10 }),
  makeLayoutField({ slug: 'mgmt_ip', fieldType: 'IP_ADDRESS', position: 11 }),
  makeLayoutField({ slug: 'admin_url', fieldType: 'URL', position: 12 }),
  makeLayoutField({
    slug: 'uplink',
    fieldType: 'ASSET_REFERENCE',
    position: 13,
    options: { targetLayoutId: 'd0000000-0000-4000-8000-0000000000d2', multiple: false },
  }),
  makeLayoutField({ slug: 'vault', fieldType: 'VAULTWARDEN_LINK', position: 14 }),
  makeLayoutField({ slug: 'photos', fieldType: 'FILE', position: 15, options: { multiple: true } }),
  makeLayoutField({ slug: 'labels', fieldType: 'TAGS', position: 16 }),
  makeLayoutField({ slug: 'mystery', fieldType: 'FUTURE_TYPE', position: 17 }),
];

const REF_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TAG_ID = '11111111-0000-4000-8000-000000000001';

function kitchenSinkAsset() {
  return makeAsset({
    name: 'srv-pines-01',
    fieldValues: {
      hostname: 'srv-pines-01',
      notes_area: '  raw\nlines  ',
      runbook: { type: 'doc', content: [] },
      ram_gb: 64,
      installed_on: '2026-03-14',
      last_boot: '2026-07-01T08:30:00+02:00',
      monitored: true,
      env: 'prod',
      roles: ['dns', 'dhcp'],
      contact_email: 'noc@example.com',
      contact_phone: '+15551230000',
      mgmt_ip: '10.20.0.5',
      admin_url: 'https://10.20.0.5:8443',
      uplink: [REF_ID],
      vault: { url: 'https://vault.example.com/item/1' },
      photos: [
        {
          uploadId: '22222222-0000-4000-8000-000000000001',
          filename: 'rack.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 12345,
          isImage: true,
          thumbnailUrl: '/api/v1/companies/c/uploads/u/image?v=thumb',
          downloadUrl: '/api/v1/companies/c/uploads/u/download',
        },
      ],
      labels: [{ id: TAG_ID, name: 'noc' }],
      mystery: { some: 'shape' },
    },
    references: {
      [REF_ID]: { id: REF_ID, name: 'core-sw-01', archivedAt: null },
    },
  });
}

describe('type gates', () => {
  it('recognises the 17 known types and rejects unknowns', () => {
    expect(isKnownFieldType('TEXT')).toBe(true);
    expect(isKnownFieldType('FUTURE_TYPE')).toBe(false);
  });

  it('RICH_TEXT / VAULTWARDEN_LINK / unknown are not editable', () => {
    expect(isMobileEditableFieldType('RICH_TEXT')).toBe(false);
    expect(isMobileEditableFieldType('VAULTWARDEN_LINK')).toBe(false);
    expect(isMobileEditableFieldType('FUTURE_TYPE')).toBe(false);
    expect(isMobileEditableFieldType('FILE')).toBe(true);
  });
});

describe('seedAssetForm (edit)', () => {
  const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());

  it('seeds readonly kinds for RICH_TEXT / VAULTWARDEN_LINK / unknown', () => {
    expect(model.values['runbook']).toEqual({ kind: 'readonly' });
    expect(model.values['vault']).toEqual({ kind: 'readonly' });
    expect(model.values['mystery']).toEqual({ kind: 'readonly' });
  });

  it('NUMBER seeds as a string; DATETIME slices to datetime-local; DATE to the day', () => {
    expect(model.values['ram_gb']).toEqual({ kind: 'text', text: '64' });
    expect(model.values['last_boot']).toEqual({ kind: 'text', text: '2026-07-01T08:30' });
    expect(model.values['installed_on']).toEqual({ kind: 'text', text: '2026-03-14' });
  });

  it('TAGS seeds chips from the hydrated read shape', () => {
    expect(model.values['labels']).toEqual({
      kind: 'tags',
      chips: [{ id: TAG_ID, name: 'noc' }],
    });
  });

  it('FILE seeds bare entries with display URLs alongside', () => {
    expect(model.values['photos']).toEqual({
      kind: 'file',
      entries: [
        {
          entry: {
            uploadId: '22222222-0000-4000-8000-000000000001',
            filename: 'rack.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 12345,
            isImage: true,
          },
          thumbnailUrl: '/api/v1/companies/c/uploads/u/image?v=thumb',
          downloadUrl: '/api/v1/companies/c/uploads/u/download',
        },
      ],
    });
  });

  it('ASSET_REFERENCE joins names from the sidecar; missing ids get null names', () => {
    expect(model.values['uplink']).toEqual({
      kind: 'reference',
      refs: [{ id: REF_ID, name: 'core-sw-01', archived: false }],
    });
    const other = seedAssetForm(
      KITCHEN_SINK,
      makeAsset({ fieldValues: { uplink: ['bbbbbbbb-0000-4000-8000-000000000002'] }, references: {} }),
    );
    expect(other.values['uplink']).toEqual({
      kind: 'reference',
      refs: [{ id: 'bbbbbbbb-0000-4000-8000-000000000002', name: null, archived: false }],
    });
  });

  it('a bare-string ASSET_REFERENCE value coerces to a 1-element list', () => {
    const m = seedAssetForm(
      KITCHEN_SINK,
      makeAsset({ fieldValues: { uplink: REF_ID }, references: {} }),
    );
    expect(m.values['uplink']).toMatchObject({ refs: [{ id: REF_ID }] });
  });

  it('out-of-catalog DROPDOWN seeds other-mode iff allowOther', () => {
    const withOther = [
      makeLayoutField({
        slug: 'env',
        fieldType: 'DROPDOWN',
        options: { choices: [{ slug: 'prod', label: 'Production' }], allowOther: true },
      }),
    ];
    const m1 = seedAssetForm(withOther, makeAsset({ fieldValues: { env: 'custom thing' } }));
    expect(m1.values['env']).toEqual({
      kind: 'dropdown',
      other: true,
      choice: '',
      otherText: 'custom thing',
    });
    const m2 = seedAssetForm(KITCHEN_SINK, makeAsset({ fieldValues: { env: 'legacy' } }));
    expect(m2.values['env']).toEqual({
      kind: 'dropdown',
      other: false,
      choice: 'legacy',
      otherText: '',
    });
  });

  it('a choice-less DROPDOWN seeds as free text (server parity)', () => {
    const freeform = [makeLayoutField({ slug: 'env', fieldType: 'DROPDOWN', options: {} })];
    const m = seedAssetForm(freeform, makeAsset({ fieldValues: { env: 'anything' } }));
    expect(m.values['env']).toEqual({ kind: 'text', text: 'anything' });
  });

  it('unparseable stored garbage seeds empty (and survives via omission)', () => {
    const m = seedAssetForm(KITCHEN_SINK, makeAsset({ fieldValues: { ram_gb: 'not-a-number' } }));
    expect(m.values['ram_gb']).toEqual({ kind: 'text', text: '' });
    expect(buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, m)).toBeNull();
  });

  it('archived layout fields are not seeded at all', () => {
    const fields = [
      makeLayoutField({ slug: 'live' }),
      makeLayoutField({ slug: 'gone', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const m = seedAssetForm(fields, null);
    expect(Object.keys(m.values)).toEqual(['live']);
  });
});

describe('round-trip integrity (the build-plan-required tests)', () => {
  it('a fully untouched form over every type produces NO payload at all', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    expect(
      buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model),
    ).toBeNull();
  });

  it('RICH_TEXT / VAULTWARDEN_LINK / unknown slugs are absent even when other fields are dirty', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    model.values['hostname'] = { kind: 'text', text: 'renamed-host' };
    const payload = buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model)!;
    expect(payload.fieldValues).toEqual({ hostname: 'renamed-host' });
    expect(payload.fieldValues).not.toHaveProperty('runbook');
    expect(payload.fieldValues).not.toHaveProperty('vault');
    expect(payload.fieldValues).not.toHaveProperty('mystery');
  });

  it('an untouched zone-suffixed DATETIME is omitted (projection equality)', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    model.values['hostname'] = { kind: 'text', text: 'renamed-host' };
    const payload = buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model)!;
    expect(payload.fieldValues).not.toHaveProperty('last_boot');
  });
});

describe('wire semantics per type', () => {
  it('cleared text sends null; whitespace-only counts as cleared (except TEXTAREA)', () => {
    expect(toWireValue({ fieldType: 'TEXT' }, { kind: 'text', text: '  ' })).toBeNull();
    expect(toWireValue({ fieldType: 'TEXT' }, { kind: 'text', text: ' x ' })).toBe('x');
    expect(toWireValue({ fieldType: 'TEXTAREA' }, { kind: 'text', text: ' raw ' })).toBe(' raw ');
    expect(toWireValue({ fieldType: 'TEXTAREA' }, { kind: 'text', text: '' })).toBeNull();
  });

  it('cleared collections send null, never []', () => {
    expect(toWireValue({ fieldType: 'MULTISELECT' }, { kind: 'multiselect', slugs: [] })).toBeNull();
    expect(toWireValue({ fieldType: 'TAGS' }, { kind: 'tags', chips: [] })).toBeNull();
    expect(toWireValue({ fieldType: 'ASSET_REFERENCE' }, { kind: 'reference', refs: [] })).toBeNull();
    expect(toWireValue({ fieldType: 'FILE' }, { kind: 'file', entries: [] })).toBeNull();
  });

  it('TAGS wires the mixed shape, never the hydrated read shape', () => {
    const wire = toWireValue(
      { fieldType: 'TAGS' },
      { kind: 'tags', chips: [{ id: TAG_ID, name: 'noc' }, { name: 'new-tag' }] },
    );
    expect(wire).toEqual([TAG_ID, { name: 'new-tag' }]);
  });

  it('FILE wires bare entries only — hydration URLs cannot leak', () => {
    const wire = toWireValue(
      { fieldType: 'FILE' },
      {
        kind: 'file',
        entries: [
          {
            entry: {
              uploadId: 'u1',
              filename: 'rack.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 10,
              isImage: true,
            },
            thumbnailUrl: '/thumb',
            downloadUrl: '/dl',
          },
        ],
      },
    ) as unknown[];
    expect(wire).toEqual([
      { uploadId: 'u1', filename: 'rack.jpg', mimeType: 'image/jpeg', sizeBytes: 10, isImage: true },
    ]);
    expect(JSON.stringify(wire)).not.toContain('thumb');
  });

  it('ASSET_REFERENCE single mode still wires a 1-element array', () => {
    expect(
      toWireValue(
        { fieldType: 'ASSET_REFERENCE' },
        { kind: 'reference', refs: [{ id: REF_ID, name: null, archived: false }] },
      ),
    ).toEqual([REF_ID]);
  });

  it('NUMBER: empty → null, parseable → number, garbage → undefined + flagged', () => {
    expect(toWireValue({ fieldType: 'NUMBER' }, { kind: 'text', text: '' })).toBeNull();
    expect(toWireValue({ fieldType: 'NUMBER' }, { kind: 'text', text: '42.5' })).toBe(42.5);
    expect(toWireValue({ fieldType: 'NUMBER' }, { kind: 'text', text: 'abc' })).toBeUndefined();

    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    model.values['ram_gb'] = { kind: 'text', text: 'abc' };
    expect(invalidNumberSlugs(KITCHEN_SINK, model)).toEqual(['ram_gb']);
    // The builder never serializes the garbage slug.
    const payload = buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model);
    expect(payload?.fieldValues ?? {}).not.toHaveProperty('ram_gb');
  });

  it('DROPDOWN other-mode wires the trimmed free text; choice-mode the slug', () => {
    expect(
      toWireValue(
        { fieldType: 'DROPDOWN' },
        { kind: 'dropdown', other: true, choice: '', otherText: ' custom ' },
      ),
    ).toBe('custom');
    expect(
      toWireValue(
        { fieldType: 'DROPDOWN' },
        { kind: 'dropdown', other: false, choice: 'prod', otherText: '' },
      ),
    ).toBe('prod');
    expect(
      toWireValue(
        { fieldType: 'DROPDOWN' },
        { kind: 'dropdown', other: false, choice: '', otherText: '' },
      ),
    ).toBeNull();
  });
});

describe('dirty tracking', () => {
  it('MULTISELECT toggled off-then-on (same set, new order) is NOT dirty', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    model.values['roles'] = { kind: 'multiselect', slugs: ['dhcp', 'dns'] };
    expect(
      buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model),
    ).toBeNull();
  });

  it('clearing a stored value IS dirty and wires null', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    model.values['mgmt_ip'] = { kind: 'text', text: '' };
    const payload = buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model)!;
    expect(payload.fieldValues).toEqual({ mgmt_ip: null });
  });

  it('removing a reference is dirty', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    model.values['uplink'] = { kind: 'reference', refs: [] };
    const payload = buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model)!;
    expect(payload.fieldValues).toEqual({ uplink: null });
  });
});

describe('name handling', () => {
  it('create: name attached only when non-empty; payload shape is {assetLayoutId, name?, fieldValues}', () => {
    const model = seedAssetForm(KITCHEN_SINK, null);
    model.values['hostname'] = { kind: 'text', text: 'new-host' };
    const withName = buildCreateAssetPayload('layout-1', '  Custom name  ', KITCHEN_SINK, model);
    expect(withName).toEqual({
      assetLayoutId: 'layout-1',
      name: 'Custom name',
      fieldValues: { hostname: 'new-host', monitored: false },
    });
    const without = buildCreateAssetPayload('layout-1', '', KITCHEN_SINK, model);
    expect(without).not.toHaveProperty('name');
  });

  it('edit: unchanged name is STILL attached (re-derive clobber guard)', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    model.values['mgmt_ip'] = { kind: 'text', text: '10.20.0.6' };
    const payload = buildUpdateAssetPayload('srv-pines-01', 'srv-pines-01', KITCHEN_SINK, model)!;
    expect(payload.name).toBe('srv-pines-01');
  });

  it('edit: name-only change produces a name-only payload', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    const payload = buildUpdateAssetPayload('srv-pines-01', 'Renamed', KITCHEN_SINK, model)!;
    expect(payload).toEqual({ name: 'Renamed' });
  });

  it('edit: clearing the name counts as dirty, omits the key, and keeps ≥1 key via fieldValues', () => {
    const model = seedAssetForm(KITCHEN_SINK, kitchenSinkAsset());
    const payload = buildUpdateAssetPayload('srv-pines-01', '  ', KITCHEN_SINK, model)!;
    expect(payload).toEqual({ fieldValues: {} });
  });
});

describe('create rule', () => {
  it('includes non-null wires only — but BOOLEAN false is always sent', () => {
    const model = seedAssetForm(KITCHEN_SINK, null);
    const payload = buildCreateAssetPayload('layout-1', '', KITCHEN_SINK, model);
    // Every other field is empty → omitted; the toggle's off state is
    // an answer and must not 400 as "missing" on a required BOOLEAN.
    expect(payload.fieldValues).toEqual({ monitored: false });
  });
});

describe('required / unsatisfiable helpers', () => {
  it('missingRequiredSlugs reports empty editable required fields, never BOOLEAN', () => {
    const fields = [
      makeLayoutField({ slug: 'hostname', fieldType: 'TEXT', isRequired: true }),
      makeLayoutField({ slug: 'monitored', fieldType: 'BOOLEAN', isRequired: true }),
    ];
    const model = seedAssetForm(fields, null);
    expect(missingRequiredSlugs(fields, model)).toEqual(['hostname']);
    model.values['hostname'] = { kind: 'text', text: 'x' };
    expect(missingRequiredSlugs(fields, model)).toEqual([]);
  });

  it('unsatisfiableRequiredFields flags required read-only types', () => {
    const fields = [
      makeLayoutField({ slug: 'runbook', fieldType: 'RICH_TEXT', isRequired: true }),
      makeLayoutField({ slug: 'hostname', fieldType: 'TEXT', isRequired: true }),
      makeLayoutField({ slug: 'mystery', fieldType: 'FUTURE_TYPE', isRequired: true }),
      makeLayoutField({
        slug: 'archived_required',
        fieldType: 'RICH_TEXT',
        isRequired: true,
        archivedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    expect(unsatisfiableRequiredFields(fields).map((f) => f.slug)).toEqual([
      'runbook',
      'mystery',
    ]);
  });
});

describe('mapAssetWriteError', () => {
  const slugs = new Set(['mgmt_ip', 'serial']);

  it('maps ValidationError issues onto known slugs (array paths collapse)', () => {
    const err = new ApiError(400, {
      error: 'ValidationError',
      issues: [
        { path: 'mgmt_ip.0', message: 'Invalid address' },
        { path: 'ghost_slug', message: 'Unknown' },
      ],
    });
    const view = mapAssetWriteError(err, slugs);
    expect(view.fieldErrors).toEqual({ mgmt_ip: 'Invalid address' });
    expect(view.formError).toContain('ghost_slug: Unknown');
  });

  it('maps UniqueFieldViolation onto its slug with the conflicting name', () => {
    const err = new ApiError(409, {
      error: 'UniqueFieldViolation',
      slug: 'serial',
      conflictingAssetName: 'srv-pines-02',
    });
    expect(mapAssetWriteError(err, slugs)).toEqual({
      formError: null,
      fieldErrors: { serial: 'Already used by “srv-pines-02”.' },
    });
  });

  it('surfaces the archived-asset copy as a form error', () => {
    const err = new ApiError(400, {
      detail: 'Cannot edit an archived asset — restore it first.',
    });
    expect(mapAssetWriteError(err, slugs).formError).toBe(
      'Cannot edit an archived asset — restore it first.',
    );
  });

  it('falls back to the problem detail, then to a generic sentence', () => {
    expect(
      mapAssetWriteError(new ApiError(400, { detail: 'Cannot create assets on an archived layout' }), slugs)
        .formError,
    ).toBe('Cannot create assets on an archived layout');
    expect(mapAssetWriteError(new Error('boom'), slugs).formError).toBe(
      "Couldn't save the asset. Try again.",
    );
  });
});

describe('model typing sanity', () => {
  it('AssetFormModel values are the discriminated union', () => {
    const v: FieldEditorValue = { kind: 'boolean', on: true };
    const model: AssetFormModel = { values: { x: v }, seeds: { x: v } };
    expect(model.values['x']!.kind).toBe('boolean');
  });
});
