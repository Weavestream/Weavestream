import { IntegrationTransformError, IntegrationTransformService } from './integration-transform.service.js';
import { computeMappingFingerprint } from '../integration-sync-runner.service.js';

describe('IntegrationTransformService', () => {
  const service = new IntegrationTransformService();

  it('applies trim and case transforms in order', () => {
    expect(
      service.execute('  MiXeD  ', { steps: [{ op: 'trim' }, { op: 'lowercase' }] }),
    ).toBe('mixed');
    expect(service.execute('mixed', { steps: [{ op: 'uppercase' }] })).toBe('MIXED');
  });

  it('coerces strict finite numbers and configured/default booleans', () => {
    expect(service.execute(' 42.5 ', { steps: [{ op: 'to_number' }] })).toBe(42.5);
    expect(service.execute('enabled', { steps: [{ op: 'to_boolean', truthy: ['enabled'] }] })).toBe(true);
    expect(service.execute('OFF', { steps: [{ op: 'to_boolean' }] })).toBe(false);
    expect(() => service.execute('12px', { steps: [{ op: 'to_number' }] })).toThrow(
      expect.objectContaining({ code: 'INVALID_NUMBER' }),
    );
  });

  it('normalizes supported dates and fails closed on custom formats', () => {
    expect(service.execute('2026-07-13T12:30:00-06:00', { steps: [{ op: 'to_date' }] })).toBe(
      '2026-07-13T18:30:00.000Z',
    );
    expect(service.execute(0, { steps: [{ op: 'to_date' }] })).toBe('1970-01-01T00:00:00.000Z');
    expect(() => service.execute('13/07/2026', { steps: [{ op: 'to_date', format: 'DD/MM/YYYY' }] })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_DATE_FORMAT' }),
    );
    expect(() => service.execute('not-a-date', { steps: [{ op: 'to_date' }] })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
    expect(service.execute('2024-02-29', { steps: [{ op: 'to_date' }] })).toBe(
      '2024-02-29T00:00:00.000Z',
    );
    expect(() => service.execute('2026-02-30', { steps: [{ op: 'to_date' }] })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
    expect(() => service.execute('2026-01-01T24:00:00Z', { steps: [{ op: 'to_date' }] })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
  });

  it('looks up enums with fallback and rejects missing mappings', () => {
    expect(service.execute('1', { steps: [{ op: 'enum_lookup', mapping: { '1': 'online' } }] })).toBe('online');
    expect(service.execute('2', { steps: [{ op: 'enum_lookup', mapping: {}, fallback: 'unknown' }] })).toBe('unknown');
    expect(() => service.execute('2', { steps: [{ op: 'enum_lookup', mapping: {} }] })).toThrow(
      expect.objectContaining({ code: 'ENUM_VALUE_NOT_FOUND' }),
    );
  });

  it('resolves first-nonempty and join paths from the original root', () => {
    const root = { device: { hostname: '  ' }, fallback: 'edge-01', site: { code: 7 } };
    expect(
      service.execute(null, { steps: [{ op: 'first_nonempty', paths: ['device.hostname', 'fallback'] }] }, root),
    ).toBe('edge-01');
    expect(
      service.execute(null, { steps: [{ op: 'join', paths: ['fallback', 'site.code'], separator: ' / ' }] }, root),
    ).toBe('edge-01 / 7');
    expect(() =>
      service.execute(null, { steps: [{ op: 'join', paths: ['device'], separator: ',' }] }, root),
    ).toThrow(expect.objectContaining({ code: 'INVALID_JOIN_VALUE' }));
  });

  it('rejects an opaque secret embedded via a join separator without echoing it', () => {
    // Bare, this opaque token trips the entropy scan; a whitespace separator
    // must not launder it into an accepted aggregate. Each resolved scalar is
    // classified at the join boundary, before concatenation.
    const secret = 'Kf9mZ2pQ7rL4wXbn6vT8cH3dSjY0aGeU4iO1kPqRtWc';
    const root = { token: secret, label: 'Firewall' };
    try {
      service.execute(null, { steps: [{ op: 'join', paths: ['token', 'label'], separator: ': ' }] }, root);
      throw new Error('expected transform to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationTransformError);
      expect(error).toMatchObject({ code: 'SECRET_INPUT' });
      expect((error as Error).message).toBe('Transform input contains sensitive material.');
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('rejects a secret-bearing markdown_table cell before assembling the table', () => {
    const secret = 'Kf9mZ2pQ7rL4wXbn6vT8cH3dSjY0aGeU4iO1kPqRtWc';
    expect(() =>
      service.execute(
        [{ name: 'edge-01', key: secret }],
        {
          steps: [
            {
              op: 'markdown_table',
              columns: [
                { header: 'Name', path: 'name' },
                { header: 'Key', path: 'key' },
              ],
            },
          ],
        },
      ),
    ).toThrow(
      expect.objectContaining({ code: 'SECRET_INPUT', message: 'Transform input contains sensitive material.' }),
    );
  });

  it('formats bytes with IEC units', () => {
    expect(service.execute(0, { steps: [{ op: 'format_bytes' }] })).toBe('0 B');
    expect(service.execute(1536, { steps: [{ op: 'format_bytes', precision: 1 }] })).toBe('1.5 KiB');
  });

  it('normalizes IPv4 CIDRs and addresses and rejects invalid values', () => {
    expect(service.execute('10.0.0.42/24', { steps: [{ op: 'normalize_cidr' }] })).toBe('10.0.0.0/24');
    expect(service.execute(' 10.0.0.42 ', { steps: [{ op: 'normalize_ip' }] })).toBe('10.0.0.42');
    expect(service.execute('010.000.000.042', { steps: [{ op: 'normalize_ip' }] })).toBe('10.0.0.42');
    expect(() => service.execute('2001:db8::1', { steps: [{ op: 'normalize_ip' }] })).toThrow(
      expect.objectContaining({ code: 'INVALID_IP' }),
    );
    expect(() => service.execute('10.0.0.1/64', { steps: [{ op: 'normalize_cidr' }] })).toThrow(
      expect.objectContaining({ code: 'INVALID_CIDR' }),
    );
  });

  it('generates a bounded escaped Markdown table', () => {
    expect(
      service.execute(
        [{ name: 'edge|01', status: 'up\nhealthy' }],
        { steps: [{ op: 'markdown_table', columns: [{ header: 'Name', path: 'name' }, { header: 'Status', path: 'status' }] }] },
      ),
    ).toBe('| Name | Status |\n| --- | --- |\n| edge\\|01 | up healthy |');
    expect(() =>
      service.execute(
        Array.from({ length: 1001 }, () => ({ name: 'x' })),
        { steps: [{ op: 'markdown_table', columns: [{ header: 'Name', path: 'name' }] }] },
      ),
    ).toThrow(expect.objectContaining({ code: 'TOO_MANY_TABLE_ROWS' }));
  });

  it('rejects unknown operations with a sanitized descriptor error', () => {
    expect(() => service.execute('x', { steps: [{ op: 'shell', command: 'cat /etc/passwd' }] } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_DESCRIPTOR', message: 'Transform descriptor is invalid.' }),
    );
  });

  it('rejects recursive, oversized, deeply nested, and over-wide input/output', () => {
    const recursive: Record<string, unknown> = {};
    recursive['self'] = recursive;
    expect(() => service.execute(recursive, { steps: [{ op: 'trim' }] })).toThrow(
      expect.objectContaining({ code: 'RECURSIVE_INPUT' }),
    );
    expect(() => service.execute('x'.repeat(262_145), { steps: [{ op: 'trim' }] })).toThrow(
      expect.objectContaining({ code: 'INPUT_TOO_LARGE' }),
    );
    let deep: unknown = 'x';
    for (let i = 0; i < 10; i += 1) deep = { child: deep };
    expect(() => service.execute(deep, { steps: [{ op: 'first_nonempty', paths: ['child'] }] })).toThrow(
      expect.objectContaining({ code: 'INPUT_TOO_DEEP' }),
    );
    expect(() => service.execute(Array.from({ length: 1025 }, () => 1), { steps: [{ op: 'join', paths: ['x'], separator: '' }] }, { x: 1 })).toThrow(
      expect.objectContaining({ code: 'INPUT_TOO_COMPLEX' }),
    );
    expect(() => service.execute(['x'.repeat(65_536)], { steps: [{ op: 'markdown_table', columns: [{ header: 'Value', path: '0' }] }] } as never)).toThrow();
  });

  it.each([
    [{ apiKey: 'provider-key' }],
    ['Bearer header.payload.signature'],
    ['https://user:password@example.test/path'],
    ['-----BEGIN PRIVATE KEY-----'],
    ['token=abcdefghijklmnopqrstuvwxyz0123456789'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature123456'],
    ['AKIAIOSFODNN7EXAMPLE'],
    ['ghp_abcdefghijklmnopqrstuvwxyz1234567890'],
  ])('rejects secret-like transformed output without echoing it: %p', (value) => {
    try {
      service.execute(value, { steps: [{ op: 'first_nonempty', paths: ['value'] }] }, { value });
      throw new Error('expected transform to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationTransformError);
      expect(error).toMatchObject({ code: 'SECRET_OUTPUT' });
      expect((error as Error).message).toBe('Transform output contains sensitive material.');
      expect((error as Error).message).not.toContain('provider-key');
    }
  });

  it.each(['accessToken', 'refresh_token', 'clientSecret'])(
    'rejects sensitive object key %s even when the value is short',
    (key) => {
      const value = { [key]: 'short' };
      expect(() => service.execute(value, { steps: [{ op: 'first_nonempty', paths: ['value'] }] }, { value })).toThrow(
        expect.objectContaining({ code: 'SECRET_OUTPUT' }),
      );
    },
  );
});

describe('computeMappingFingerprint', () => {
  const base = {
    sourceField: 'hostname',
    targetField: { id: 'field-1' },
    syncDirection: 'source_wins' as const,
  };

  it('canonically includes transform descriptors', () => {
    const trim = computeMappingFingerprint([{ ...base, transform: { steps: [{ op: 'trim' }] } }]);
    const lower = computeMappingFingerprint([{ ...base, transform: { steps: [{ op: 'lowercase' }] } }]);
    expect(trim).not.toBe(lower);
    expect(
      computeMappingFingerprint([{ ...base, transform: { steps: [{ op: 'enum_lookup', mapping: { b: '2', a: '1' } }] } }]),
    ).toBe(
      computeMappingFingerprint([{ ...base, transform: { steps: [{ op: 'enum_lookup', mapping: { a: '1', b: '2' } }] } }]),
    );
  });
});
