import { FILE_MULTI_CAP, FieldTypeValues } from '@weavestream/shared';
import { FieldTypesRegistry } from './field-types.registry.js';

describe('FieldTypesRegistry (exhaustive)', () => {
  const registry = new FieldTypesRegistry();

  it('has a strategy for every FieldType enum value', () => {
    for (const kind of FieldTypeValues) {
      expect(registry.get(kind).kind).toBe(kind);
    }
    expect(registry.all().length).toBe(FieldTypeValues.length);
  });
});

describe('TextStrategy', () => {
  const registry = new FieldTypesRegistry();

  it('trims and stores null on empty', () => {
    const s = registry.get('TEXT');
    expect(s.normalize('  hello  ', {})).toBe('hello');
    expect(s.normalize('', {})).toBeNull();
  });

  it('rejects oversize strings via valueSchema', () => {
    const s = registry.get('TEXT');
    const schema = s.valueSchema({});
    const big = 'x'.repeat(10_001);
    expect(schema.safeParse(big).success).toBe(false);
    expect(schema.safeParse('ok').success).toBe(true);
  });
});

describe('EmailStrategy', () => {
  const registry = new FieldTypesRegistry();

  it('lowercases on normalize', () => {
    expect(registry.get('EMAIL').normalize('Hannah@Northwind.COM', {})).toBe(
      'hannah@northwind.com',
    );
  });

  it('rejects invalid email via valueSchema', () => {
    const s = registry.get('EMAIL');
    const ok = s.valueSchema({});
    expect(ok.safeParse('hannah@northwind.com').success).toBe(true);
    expect(ok.safeParse('not-an-email').success).toBe(false);
  });
});

describe('PhoneStrategy', () => {
  const registry = new FieldTypesRegistry();
  it('canonicalises 10-digit US numbers to E.164', () => {
    expect(registry.get('PHONE').normalize('(555) 123-4567', {})).toBe('+15551234567');
  });
  it('keeps already-prefixed numbers', () => {
    expect(registry.get('PHONE').normalize('+442079460000', {})).toBe('+442079460000');
  });
});

describe('DateStrategy', () => {
  const registry = new FieldTypesRegistry();
  it('truncates datetimes to the date part', () => {
    expect(registry.get('DATE').normalize('2026-06-30T12:00:00Z', {})).toBe('2026-06-30');
  });
  it('accepts ISO dates via valueSchema', () => {
    expect(registry.get('DATE').valueSchema({}).safeParse('2026-06-30').success).toBe(true);
    expect(registry.get('DATE').valueSchema({}).safeParse('06/30/26').success).toBe(false);
  });
});

describe('DropdownStrategy', () => {
  const registry = new FieldTypesRegistry();
  const options = {
    choices: [
      { label: 'Windows 11', slug: 'windows_11' },
      { label: 'Ubuntu 24.04', slug: 'ubuntu_24_04' },
    ],
    allowOther: false,
  };

  it('restricts to declared slugs', () => {
    const schema = registry.get('DROPDOWN').valueSchema(options);
    expect(schema.safeParse('windows_11').success).toBe(true);
    expect(schema.safeParse('macos').success).toBe(false);
    expect(schema.safeParse(null).success).toBe(true);
  });

  it('round-trips to plaintext labels', () => {
    expect(registry.get('DROPDOWN').toPlaintext('windows_11', options)).toBe('Windows 11');
  });
});

describe('MultiselectStrategy', () => {
  const registry = new FieldTypesRegistry();
  const opts = {
    choices: [
      { label: 'Clinical', slug: 'clinical' },
      { label: 'Imaging', slug: 'imaging' },
    ],
  };
  it('deduplicates inputs in normalize', () => {
    expect(
      registry.get('MULTISELECT').normalize(['clinical', 'clinical', 'imaging'], opts),
    ).toEqual(['clinical', 'imaging']);
  });
  it('rejects unknown slugs via valueSchema', () => {
    const schema = registry.get('MULTISELECT').valueSchema(opts);
    expect(schema.safeParse(['clinical']).success).toBe(true);
    expect(schema.safeParse(['nope']).success).toBe(false);
  });
});

describe('BooleanStrategy', () => {
  const registry = new FieldTypesRegistry();
  it("coerces 'true' / 'false' strings", () => {
    expect(registry.get('BOOLEAN').normalize('true', {})).toBe(true);
    expect(registry.get('BOOLEAN').normalize('false', {})).toBe(false);
  });
});

describe('NumberStrategy', () => {
  const registry = new FieldTypesRegistry();
  it('rejects infinities', () => {
    expect(registry.get('NUMBER').valueSchema({}).safeParse(Infinity).success).toBe(false);
  });
  it('parses numeric strings', () => {
    expect(registry.get('NUMBER').normalize('42', {})).toBe(42);
  });
});

describe('AssetReferenceStrategy', () => {
  const registry = new FieldTypesRegistry();

  it('widens a single uuid to a 1-element array', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    expect(registry.get('ASSET_REFERENCE').normalize(id, {})).toEqual([id]);
  });

  it('deduplicates target ids', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    expect(
      registry.get('ASSET_REFERENCE').normalize([id, id, id], {}),
    ).toEqual([id]);
  });

  it('rejects multi-valued inputs when multiple=false', () => {
    const id1 = '00000000-0000-0000-0000-000000000001';
    const id2 = '00000000-0000-0000-0000-000000000002';
    const schema = registry.get('ASSET_REFERENCE').valueSchema({ multiple: false });
    expect(schema.safeParse([id1]).success).toBe(true);
    expect(schema.safeParse([id1, id2]).success).toBe(false);
  });

  it('calls replaceForField inside onRelate with dedup ids', async () => {
    const calls: unknown[] = [];
    const relations = {
      async replaceForField(args: unknown) {
        calls.push(args);
      },
    };
    const strategy = registry.get('ASSET_REFERENCE');
    const id = '00000000-0000-0000-0000-000000000001';
    await strategy.onRelate?.([id, id], {
      companyId: 'c-1',
      assetId: 'a-1',
      actorId: 'u-1',
      field: { id: 'f-1', slug: 'primary_user', options: { relationType: 'primary_user' } },
      tx: {} as never,
      relations,
    });
    expect(calls).toHaveLength(1);
    const first = calls[0] as { targetIds: string[]; relationType: string };
    expect(first.targetIds).toEqual([id, id]);
    expect(first.relationType).toBe('primary_user');
  });
});

describe('RichTextStrategy', () => {
  const registry = new FieldTypesRegistry();
  const strat = registry.get('RICH_TEXT');

  it('lifts a plain string into a Tiptap doc', () => {
    const v = strat.normalize('Hello world', {}) as {
      type: string;
      content: Array<{ type: string }>;
    };
    expect(v.type).toBe('doc');
    expect(Array.isArray(v.content)).toBe(true);
  });

  it('passes a raw Tiptap doc (with headings + lists) through valueSchema', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(strat.valueSchema({}).safeParse(doc).success).toBe(true);
    expect(strat.normalize(doc, {})).toEqual(doc);
  });

  it('rejects non-doc objects', () => {
    expect(strat.valueSchema({}).safeParse({ type: 'paragraph' }).success).toBe(false);
    expect(strat.valueSchema({}).safeParse({ foo: 'bar' }).success).toBe(false);
  });

  it('unwraps the legacy {v, plain} shape on normalize', () => {
    const wrapped = {
      v: { type: 'doc', content: [{ type: 'paragraph' }] },
      plain: 'Hi',
    };
    const v = strat.normalize(wrapped, {}) as { type: string };
    expect(v.type).toBe('doc');
  });

  it('toPlaintext walks the Tiptap doc for search', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    };
    expect(strat.toPlaintext(doc, {})).toContain('one');
    expect(strat.toPlaintext(doc, {})).toContain('two');
  });

  it('toPlaintext still honours the legacy plain field when present', () => {
    expect(
      strat.toPlaintext(
        { v: { type: 'doc', content: [] }, plain: 'Hi' },
        {},
      ),
    ).toBe('Hi');
  });
});

describe('FileStrategy', () => {
  const registry = new FieldTypesRegistry();

  // Valid fileFieldEntrySchema entries — uploadId must be a real UUID.
  const entry = (n: number) => ({
    uploadId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    filename: `file-${n}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1,
  });
  const entries = (count: number) =>
    Array.from({ length: count }, (_, i) => entry(i));

  it('caps at 1 when multiple is absent — absent means single, the desktop-parity contract', () => {
    const schema = registry.get('FILE').valueSchema({});
    expect(schema.safeParse([entry(1)]).success).toBe(true);
    expect(schema.safeParse([entry(1), entry(2)]).success).toBe(false);
  });

  it('caps at 1 when multiple=false', () => {
    const schema = registry.get('FILE').valueSchema({ multiple: false });
    expect(schema.safeParse([entry(1)]).success).toBe(true);
    expect(schema.safeParse([entry(1), entry(2)]).success).toBe(false);
  });

  it('caps at FILE_MULTI_CAP when multiple=true', () => {
    const schema = registry.get('FILE').valueSchema({ multiple: true });
    expect(schema.safeParse(entries(FILE_MULTI_CAP)).success).toBe(true);
    expect(schema.safeParse(entries(FILE_MULTI_CAP + 1)).success).toBe(false);
  });

  it('accepts null in both modes', () => {
    expect(registry.get('FILE').valueSchema({}).safeParse(null).success).toBe(true);
    expect(
      registry.get('FILE').valueSchema({ multiple: true }).safeParse(null).success,
    ).toBe(true);
  });
});

describe('TagsStrategy', () => {
  const registry = new FieldTypesRegistry();

  it('valueSchema accepts a mixed array of UUIDs and { name } objects', () => {
    const schema = registry.get('TAGS').valueSchema({});
    const uuid = '11111111-1111-1111-1111-111111111111';
    expect(schema.safeParse([uuid]).success).toBe(true);
    expect(schema.safeParse([{ name: 'Production' }]).success).toBe(true);
    expect(schema.safeParse([uuid, { name: 'New' }]).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    // Non-UUID raw strings are no longer accepted — names must come in as
    // `{ name }` so the asset-write tx can resolve them via preResolve.
    expect(schema.safeParse(['not-a-uuid']).success).toBe(false);
  });

  it('preResolve upserts new names through the TagsPort and dedupes ids', async () => {
    const created = new Map<string, string>();
    const port = {
      upsertByName: async (name: string) => {
        const lower = name.trim().toLowerCase();
        const existing = created.get(lower);
        if (existing) return existing;
        const id = `tag-${created.size + 1}`;
        created.set(lower, id);
        return id;
      },
    };
    const ctx = {
      tx: {} as never,
      tags: port,
      actorId: null,
      audit: null,
    };
    const out = await registry
      .get('TAGS')
      .preResolve!([
        '11111111-1111-1111-1111-111111111111',
        { name: 'Production' },
        { name: 'production' },
        '11111111-1111-1111-1111-111111111111',
      ], {}, ctx);
    expect(out).toEqual([
      '11111111-1111-1111-1111-111111111111',
      'tag-1',
    ]);
  });

  it('preResolve forwards audit metadata to the TagsPort upsert call', async () => {
    const calls: Array<{ name: string; audit: unknown }> = [];
    const port = {
      upsertByName: async (
        name: string,
        _tx: unknown,
        audit: unknown,
      ) => {
        calls.push({ name, audit });
        return `tag-${calls.length}`;
      },
    };
    const audit = {
      actorId: 'u-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
    };
    const ctx = {
      tx: {} as never,
      tags: port,
      actorId: 'u-1',
      audit,
    };
    await registry
      .get('TAGS')
      .preResolve!([{ name: 'Production' }], {}, ctx);
    expect(calls).toEqual([{ name: 'Production', audit }]);
  });

  it('normalize dedupes and preserves casing of UUID arrays', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(registry.get('TAGS').normalize([a, b, a], {})).toEqual([a, b]);
  });

  it('toPlaintext returns empty string (search hydration is out of scope)', () => {
    expect(registry.get('TAGS').toPlaintext([], {})).toBe('');
  });
});

describe('IpAddressStrategy', () => {
  const registry = new FieldTypesRegistry();
  const any = { version: 'any', allowCidr: false };
  const v4Only = { version: 'v4', allowCidr: false };
  const withCidr = { version: 'any', allowCidr: true };

  it('accepts IPv4 host addresses', () => {
    expect(registry.get('IP_ADDRESS').valueSchema(any).safeParse('10.0.0.5').success).toBe(true);
    expect(registry.get('IP_ADDRESS').valueSchema(any).safeParse('999.0.0.1').success).toBe(false);
  });

  it('accepts IPv6 and lowercases on normalize', () => {
    const s = registry.get('IP_ADDRESS');
    expect(s.valueSchema(any).safeParse('2001:DB8::1').success).toBe(true);
    expect(s.normalize('2001:DB8::1', any)).toBe('2001:db8::1');
  });

  it('trims whitespace and nulls empty input', () => {
    const s = registry.get('IP_ADDRESS');
    expect(s.normalize('  192.168.1.1  ', any)).toBe('192.168.1.1');
    expect(s.normalize('', any)).toBeNull();
  });

  it('respects the version restriction', () => {
    const schema = registry.get('IP_ADDRESS').valueSchema(v4Only);
    expect(schema.safeParse('10.0.0.1').success).toBe(true);
    expect(schema.safeParse('2001:db8::1').success).toBe(false);
  });

  it('accepts CIDR only when allowCidr is true', () => {
    const s = registry.get('IP_ADDRESS');
    expect(s.valueSchema(any).safeParse('10.0.0.0/24').success).toBe(false);
    expect(s.valueSchema(withCidr).safeParse('10.0.0.0/24').success).toBe(true);
    expect(s.valueSchema(withCidr).safeParse('10.0.0.0/33').success).toBe(false);
    expect(s.valueSchema(withCidr).safeParse('2001:db8::/129').success).toBe(false);
    expect(s.valueSchema(withCidr).safeParse('2001:db8::/48').success).toBe(true);
  });

  it('returns null from normalize when input is not a valid IP', () => {
    // Drivers that flatten multi-NIC endpoints sometimes hand us a
    // comma-separated list. We refuse to persist that as a typed IP —
    // returning null lets the integration sync runner clear the value
    // instead of leaking malformed strings into Postgres `inet` queries.
    const s = registry.get('IP_ADDRESS');
    expect(s.normalize('10.0.0.35, 10.0.0.50', any)).toBeNull();
    expect(s.normalize('not-an-ip', any)).toBeNull();
    expect(s.normalize('10.0.0.999', any)).toBeNull();
  });
});
