import type { LayoutFieldSummary } from '@weavestream/shared';
import {
  CANVAS_DROPZONE_ID,
  PALETTE_DRAG_PREFIX,
  activeLayoutFields,
  countTableColumns,
  fieldsFromTemplate,
  initialBuilderState,
  isDirty,
  layoutBuilderReducer as reduce,
  prepareSave,
} from './layout-builder-state';
import type { BuilderField, BuilderState } from './types';

function field(key: string, overrides: Partial<BuilderField> = {}): BuilderField {
  return {
    id: key,
    key,
    name: key.toUpperCase(),
    slug: key,
    fieldType: 'TEXT',
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: false,
    showInTable: false,
    options: {},
    ...overrides,
  };
}

function stateOf(...fields: BuilderField[]): BuilderState {
  return initialBuilderState(fields);
}

const keys = (s: BuilderState) => s.fields.map((f) => f.key);
const primaries = (s: BuilderState) => s.fields.filter((f) => f.isPrimary).map((f) => f.key);

describe('initialBuilderState', () => {
  it('selects the first field and uses the fields as the baseline', () => {
    const s = stateOf(field('a'), field('b'));
    expect(s.selectedKey).toBe('a');
    expect(isDirty(s.fields, s.baseline)).toBe(false);
  });

  it('selects nothing for an empty layout', () => {
    expect(stateOf().selectedKey).toBeNull();
  });
});

describe('add', () => {
  it('makes the first field of an empty layout primary and selects it', () => {
    const s = reduce(stateOf(), { type: 'add', fieldType: 'TEXT', key: 'n1' });
    expect(keys(s)).toEqual(['n1']);
    expect(primaries(s)).toEqual(['n1']);
    expect(s.selectedKey).toBe('n1');
  });

  it('never adds a second primary', () => {
    const s = reduce(stateOf(field('a', { isPrimary: true })), {
      type: 'add',
      fieldType: 'TEXT',
      key: 'n1',
    });
    expect(primaries(s)).toEqual(['a']);
  });

  it('inserts at the given index, else at the end', () => {
    const base = stateOf(field('a', { isPrimary: true }), field('b'));
    expect(keys(reduce(base, { type: 'add', fieldType: 'TEXT', key: 'n', atIndex: 1 }))).toEqual([
      'a',
      'n',
      'b',
    ]);
    expect(keys(reduce(base, { type: 'add', fieldType: 'TEXT', key: 'n' }))).toEqual([
      'a',
      'b',
      'n',
    ]);
  });

  it('starts blank, unsaved, and with the kind’s option skeleton', () => {
    const s = reduce(stateOf(), { type: 'add', fieldType: 'DROPDOWN', key: 'n' });
    expect(s.fields[0]!.id).toBeUndefined();
    expect(s.fields[0]).toMatchObject({
      name: '',
      slug: '',
      options: { choices: [], allowOther: false },
    });
  });
});

describe('remove', () => {
  it('promotes the first remaining field when the primary is removed', () => {
    const s = reduce(stateOf(field('a', { isPrimary: true }), field('b'), field('c')), {
      type: 'remove',
      key: 'a',
    });
    expect(keys(s)).toEqual(['b', 'c']);
    expect(primaries(s)).toEqual(['b']);
  });

  it('leaves the primary alone when another field is removed', () => {
    const s = reduce(stateOf(field('a'), field('b', { isPrimary: true })), {
      type: 'remove',
      key: 'a',
    });
    expect(primaries(s)).toEqual(['b']);
  });

  it('clears the selection only when the selected field is removed', () => {
    const base = reduce(stateOf(field('a', { isPrimary: true }), field('b')), {
      type: 'select',
      key: 'b',
    });
    expect(reduce(base, { type: 'remove', key: 'b' }).selectedKey).toBeNull();
    expect(reduce(base, { type: 'remove', key: 'a' }).selectedKey).toBe('b');
  });

  it('removes the last field without inventing a primary', () => {
    const s = reduce(stateOf(field('a', { isPrimary: true })), { type: 'remove', key: 'a' });
    expect(s.fields).toEqual([]);
  });
});

describe('setPrimary', () => {
  it('transfers the designation, demoting the old primary in the same step', () => {
    const s = reduce(stateOf(field('a', { isPrimary: true }), field('b')), {
      type: 'setPrimary',
      key: 'b',
    });
    expect(primaries(s)).toEqual(['b']);
  });
});

describe('update', () => {
  it('patches only the target field', () => {
    const s = reduce(stateOf(field('a'), field('b')), {
      type: 'update',
      key: 'b',
      patch: { name: 'Renamed' },
    });
    expect(s.fields.map((f) => f.name)).toEqual(['A', 'Renamed']);
  });

  it('copies patched options rather than aliasing the caller’s object', () => {
    const options = { isExpiry: true };
    const s = reduce(stateOf(field('a')), { type: 'update', key: 'a', patch: { options } });
    expect(s.fields[0]!.options).toEqual(options);
    expect(s.fields[0]!.options).not.toBe(options);
  });
});

describe('drag', () => {
  const base = stateOf(field('a', { isPrimary: true }), field('b'), field('c'));

  it('tracks a palette drag and a field drag', () => {
    expect(
      reduce(base, { type: 'dragStart', activeId: `${PALETTE_DRAG_PREFIX}DATE` }).drag,
    ).toEqual({ kind: 'palette', fieldType: 'DATE' });
    expect(reduce(base, { type: 'dragStart', activeId: 'b' }).drag).toEqual({
      kind: 'field',
      key: 'b',
    });
  });

  it('reorders a canvas row onto another row and clears the drag', () => {
    const dragging = reduce(base, { type: 'dragStart', activeId: 'a' });
    const s = reduce(dragging, { type: 'dragEnd', activeId: 'a', overId: 'c', key: 'unused' });
    expect(keys(s)).toEqual(['b', 'c', 'a']);
    expect(s.drag).toBeNull();
  });

  it('inserts a palette drop at the target row', () => {
    const s = reduce(base, {
      type: 'dragEnd',
      activeId: `${PALETTE_DRAG_PREFIX}DATE`,
      overId: 'b',
      key: 'n',
    });
    expect(keys(s)).toEqual(['a', 'n', 'b', 'c']);
    expect(s.fields[1]!.fieldType).toBe('DATE');
    expect(s.selectedKey).toBe('n');
  });

  it('appends a palette drop on the dropzone or an unknown target', () => {
    for (const overId of [CANVAS_DROPZONE_ID, 'gone']) {
      const s = reduce(base, {
        type: 'dragEnd',
        activeId: `${PALETTE_DRAG_PREFIX}TEXT`,
        overId,
        key: 'n',
      });
      expect(keys(s)).toEqual(['a', 'b', 'c', 'n']);
    }
  });

  it('changes nothing when dropped outside, on itself, or on an unknown row', () => {
    for (const overId of [null, 'a', 'gone']) {
      const s = reduce(base, { type: 'dragEnd', activeId: 'a', overId, key: 'n' });
      expect(keys(s)).toEqual(['a', 'b', 'c']);
      expect(s.drag).toBeNull();
    }
  });
});

describe('isDirty', () => {
  const base = [field('a', { isPrimary: true }), field('b')];

  it('is clean for identical lists', () => {
    expect(isDirty(base, base.map((f) => ({ ...f, options: { ...f.options } })))).toBe(false);
  });

  it('flags added, removed, and reordered fields', () => {
    expect(isDirty([...base, field('c')], base)).toBe(true);
    expect(isDirty([base[0]!], base)).toBe(true);
    expect(isDirty([base[1]!, base[0]!], base)).toBe(true);
  });

  it.each<[string, Partial<BuilderField>]>([
    ['name', { name: 'x' }],
    ['slug', { slug: 'x' }],
    ['fieldType', { fieldType: 'DATE' }],
    ['isRequired', { isRequired: true }],
    ['isUniquePerCompany', { isUniquePerCompany: true }],
    ['visibleToClients', { visibleToClients: false }],
    ['isPrimary', { isPrimary: true }],
    ['showInTable', { showInTable: true }],
    ['options', { options: { multiple: true } }],
  ])('flags a change to %s', (_name, patch) => {
    expect(isDirty([base[0]!, { ...base[1]!, ...patch }], base)).toBe(true);
  });

  it('reports a seeded template as unsaved until it is saved', () => {
    const s = reduce(stateOf(), { type: 'seed', fields: [field('t1', { id: undefined })] });
    expect(isDirty(s.fields, s.baseline)).toBe(true);
    expect(s.selectedKey).toBe('t1');
  });
});

describe('reset and saved', () => {
  it('reset takes a fresh server snapshot as working copy and baseline', () => {
    const edited = reduce(stateOf(field('a')), {
      type: 'update',
      key: 'a',
      patch: { name: 'x' },
    });
    const s = reduce(edited, { type: 'reset', fields: [field('a'), field('b')] });
    expect(keys(s)).toEqual(['a', 'b']);
    expect(isDirty(s.fields, s.baseline)).toBe(false);
  });

  it('re-anchors the selection on the saved row by slug', () => {
    const added = reduce(stateOf(field('a', { isPrimary: true })), {
      type: 'add',
      fieldType: 'TEXT',
      key: 'new-1',
    });
    const sent = added.fields.map((f) => (f.key === 'new-1' ? { ...f, slug: 'serial' } : f));
    const s = reduce(
      { ...added, fields: sent },
      { type: 'saved', sent, serverFields: [field('a', { isPrimary: true }), field('srv-9', { slug: 'serial' })] },
    );
    expect(s.selectedKey).toBe('srv-9');
    expect(isDirty(s.fields, s.baseline)).toBe(false);
  });

  it('drops the selection when the saved row has no match', () => {
    const s = reduce(stateOf(field('a')), {
      type: 'saved',
      sent: [field('a')],
      serverFields: [field('z')],
    });
    expect(s.selectedKey).toBeNull();
  });

  it('falls back to the submitted copy as baseline when the server sends no fields', () => {
    const sent = [field('a', { name: 'Saved' })];
    const later = [field('a', { name: 'Edited after submit' })];
    const s = reduce(
      { ...stateOf(field('a')), fields: later },
      { type: 'saved', sent, serverFields: null },
    );
    expect(s.fields).toBe(later);
    expect(s.baseline).toEqual(sent);
    expect(isDirty(s.fields, s.baseline)).toBe(true);
  });
});

describe('fieldsFromTemplate', () => {
  let n = 0;
  const makeKey = () => `k${++n}`;
  beforeEach(() => {
    n = 0;
  });

  it('falls back to the first field as primary when the template marks none', () => {
    const rows = fieldsFromTemplate(
      [
        { name: 'Name', slug: 'name', fieldType: 'TEXT' },
        { name: 'Notes', slug: 'notes', fieldType: 'TEXTAREA' },
      ],
      makeKey,
    );
    expect(rows.map((r) => r.isPrimary)).toEqual([true, false]);
    expect(rows.map((r) => r.key)).toEqual(['k1', 'k2']);
    expect(rows.every((r) => r.id === undefined)).toBe(true);
  });

  it('keeps the template’s primary and merges options over the skeleton', () => {
    const rows = fieldsFromTemplate(
      [
        { name: 'Name', slug: 'name', fieldType: 'TEXT' },
        {
          name: 'IP',
          slug: 'ip',
          fieldType: 'IP_ADDRESS',
          isPrimary: true,
          options: { allowCidr: true },
        },
      ],
      makeKey,
    );
    expect(rows.map((r) => r.isPrimary)).toEqual([false, true]);
    expect(rows[1]!.options).toEqual({ version: 'any', allowCidr: true });
  });

  it('never marks a non-tabular type as a table column', () => {
    const [row] = fieldsFromTemplate(
      [{ name: 'Body', slug: 'body', fieldType: 'RICH_TEXT', showInTable: true }],
      makeKey,
    );
    expect(row!.showInTable).toBe(false);
  });
});

describe('countTableColumns', () => {
  it('counts the primary plus opted-in tabular fields only', () => {
    expect(
      countTableColumns([
        field('a', { isPrimary: true }),
        field('b', { showInTable: true }),
        field('c', { showInTable: true, fieldType: 'RICH_TEXT' }),
        field('d'),
      ]),
    ).toBe(2);
  });
});

describe('activeLayoutFields', () => {
  it('drops archived fields and sorts by position', () => {
    const rows = [
      { id: 'b', position: 2, archivedAt: null },
      { id: 'x', position: 0, archivedAt: '2026-01-01T00:00:00Z' },
      { id: 'a', position: 1, archivedAt: null },
    ] as unknown as LayoutFieldSummary[];
    expect(activeLayoutFields(rows).map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('prepareSave', () => {
  // Persisted ids must be UUIDs, so these rows are unsaved ones.
  const draft = (key: string, overrides: Partial<BuilderField> = {}) =>
    field(key, { id: undefined, ...overrides });

  it('sends positions in list order and strips showInTable from non-tabular types', () => {
    const res = prepareSave([
      draft('a', { isPrimary: true, name: 'Name', slug: 'name' }),
      draft('b', { name: 'Body', slug: 'body', fieldType: 'RICH_TEXT', showInTable: true }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.fields.map((f) => [f.slug, f.position, f.showInTable])).toEqual([
      ['name', 0, false],
      ['body', 1, false],
    ]);
  });

  it('sends the id of persisted rows and omits it for unsaved ones', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const res = prepareSave([
      field('a', { id, isPrimary: true, slug: 'name' }),
      draft('new-1', { slug: 'serial' }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.fields[0]!.id).toBe(id);
    expect('id' in res.payload.fields[1]!).toBe(false);
  });

  it('rejects a list without exactly one primary', () => {
    const res = prepareSave([draft('a', { slug: 'name' })]);
    expect(res).toEqual({ ok: false, error: 'Exactly one field must be marked primary' });
  });

  it('names the field whose options are invalid', () => {
    const res = prepareSave([
      draft('a', { isPrimary: true, slug: 'name' }),
      draft('b', { slug: 'kind', fieldType: 'DROPDOWN', options: { choices: 'nope' } }),
    ]);
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toMatch(/^Field "kind" \(DROPDOWN\) has invalid options:/);
  });
});
