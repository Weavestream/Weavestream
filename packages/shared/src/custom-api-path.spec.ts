import {
  CustomApiPathError,
  formatPath,
  isValidPath,
  listScalarPaths,
  parsePath,
  readPath,
  resolvePath,
} from './custom-api-path.js';

describe('parsePath', () => {
  it.each([
    ['', []],
    ['data', ['data']],
    ['data.items', ['data', 'items']],
    ['system.serial', ['system', 'serial']],
    ['addresses[0].value', ['addresses', 0, 'value']],
    ['[2]', [2]],
    ['matrix[1][0]', ['matrix', 1, 0]],
    ['["odd key"].value', ['odd key', 'value']],
    ['a["b.c"]', ['a', 'b.c']],
    ['["say \\"hi\\""]', ['say "hi"']],
    ['["back\\\\slash"]', ['back\\slash']],
    ['last-contact_at', ['last-contact_at']],
  ])('parses %j', (path, parts) => {
    expect(parsePath(path)).toEqual(parts);
  });

  it.each([
    ['.a', 'empty key'],
    ['a.', 'end with a dot'],
    ['a..b', 'empty key'],
    ['a.[0]', 'followed by a key'],
    ['a[x]', 'whole number'],
    ['a[]', 'whole number'],
    ['a[0]b', 'continues with'],
    ['a b', 'separated by dots'],
    [' a', 'quoted key'],
    ['["open', 'not closed'],
    ['["bad \\n"]', 'unknown escape'],
    ['__proto__', 'not allowed'],
    ['a.constructor', 'not allowed'],
    ['["prototype"]', 'not allowed'],
    ['a[1234567]', 'too large'],
  ])('refuses %j', (path, message) => {
    expect(() => parsePath(path)).toThrow(CustomApiPathError);
    expect(() => parsePath(path)).toThrow(new RegExp(message));
  });

  it('limits a path to 16 parts and 256 characters', () => {
    expect(parsePath(Array.from({ length: 16 }, (_, i) => `k${i}`).join('.'))).toHaveLength(16);
    expect(() => parsePath(Array.from({ length: 17 }, (_, i) => `k${i}`).join('.'))).toThrow(/16 parts/);
    expect(() => parsePath(`a${'b'.repeat(256)}`)).toThrow(/256 characters/);
  });

  it('isValidPath answers without throwing', () => {
    expect(isValidPath('a.b')).toBe(true);
    expect(isValidPath('a..b')).toBe(false);
  });
});

describe('readPath', () => {
  const record = {
    id: 42,
    name: 'pc-01',
    system: { serial: 'SN1', ram: null, disks: [{ size: 512 }], flags: { a: 1 } },
    addresses: [{ value: '10.0.0.5' }],
    enabled: false,
    'odd key': { value: 'x' },
  };

  it('reads single values through keys, indexes and quoted keys', () => {
    expect(readPath(record, parsePath('system.serial'))).toEqual({ kind: 'value', value: 'SN1' });
    expect(readPath(record, parsePath('id'))).toEqual({ kind: 'value', value: 42 });
    expect(readPath(record, parsePath('enabled'))).toEqual({ kind: 'value', value: false });
    expect(readPath(record, parsePath('addresses[0].value'))).toEqual({ kind: 'value', value: '10.0.0.5' });
    expect(readPath(record, parsePath('system.disks[0].size'))).toEqual({ kind: 'value', value: 512 });
    expect(readPath(record, parsePath('["odd key"].value'))).toEqual({ kind: 'value', value: 'x' });
  });

  it('treats absent and null values as missing', () => {
    expect(readPath(record, parsePath('system.ram'))).toEqual({ kind: 'missing' });
    expect(readPath(record, parsePath('system.nothing'))).toEqual({ kind: 'missing' });
    expect(readPath(record, parsePath('addresses[3].value'))).toEqual({ kind: 'missing' });
    expect(readPath(record, parsePath('name.length'))).toEqual({ kind: 'missing' });
    expect(readPath(record, parsePath('addresses.value'))).toEqual({ kind: 'missing' });
  });

  it('reports objects and lists as not a single value', () => {
    expect(readPath(record, parsePath('system.flags'))).toEqual({ kind: 'not_scalar' });
    expect(readPath(record, parsePath('addresses'))).toEqual({ kind: 'not_scalar' });
  });

  it('reads own properties only', () => {
    const inherited = Object.create({ secret: 'from-prototype' }) as Record<string, unknown>;
    expect(readPath(inherited, ['secret'])).toEqual({ kind: 'missing' });
    expect(resolvePath({}, ['toString'])).toBeUndefined();
    expect(resolvePath({}, ['__proto__'])).toBeUndefined();
  });

  it('resolvePath with no parts gives the root', () => {
    const list = [1, 2];
    expect(resolvePath(list, [])).toBe(list);
  });
});

describe('formatPath and listScalarPaths', () => {
  it('formats parts so they parse back', () => {
    for (const parts of [['a', 'b'], ['a', 0, 'b'], ['odd key', 'v'], ['say "hi"'], [3, 'x']] as Array<Array<string | number>>) {
      expect(parsePath(formatPath(parts))).toEqual(parts);
    }
  });

  it('lists every single value with its path and type', () => {
    const entries = listScalarPaths({ id: 1, system: { serial: 'SN', ok: true }, tags: ['a'], gone: null, 'my key': 'v' }, { maxEntries: 50 });
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ['id', 'number'],
      ['system.serial', 'string'],
      ['system.ok', 'boolean'],
      ['tags[0]', 'string'],
      ['gone', 'null'],
      ['["my key"]', 'string'],
    ]);
  });

  it('stops at the entry limit and skips keys no path may name', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(listScalarPaths(many, { maxEntries: 10 })).toHaveLength(10);
    const hostile = JSON.parse('{"__proto__": {"x": 1}, "ok": 2}') as unknown;
    expect(listScalarPaths(hostile, { maxEntries: 10 }).map((e) => e.path)).toEqual(['ok']);
  });
});
