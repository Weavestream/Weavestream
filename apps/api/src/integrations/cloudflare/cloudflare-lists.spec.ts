import {
  cloudflareAddEntrySchema,
  cloudflareIpEntryValueSchema,
  parseIpEntry,
} from '@weavestream/shared';

/**
 * Cloudflare Rules Lists — schema and validator regression tests.
 *
 * The CIDR validator runs both client-side (Next.js dialog) and
 * server-side (Zod refinement on the controller body), so its
 * canonicalisation must be stable across both.
 */
describe('cloudflare validators', () => {
  describe('parseIpEntry', () => {
    it('accepts and canonicalises IPv4 + IPv4 CIDR', () => {
      expect(parseIpEntry('203.0.113.42')).toEqual({
        kind: 'ipv4',
        canonical: '203.0.113.42',
        prefix: null,
      });
      expect(parseIpEntry('  10.0.0.0/8 ')).toEqual({
        kind: 'ipv4',
        canonical: '10.0.0.0/8',
        prefix: 8,
      });
    });

    it('accepts and lowercases IPv6 + IPv6 CIDR', () => {
      expect(parseIpEntry('2001:DB8::1')).toEqual({
        kind: 'ipv6',
        canonical: '2001:db8::1',
        prefix: null,
      });
      expect(parseIpEntry('2001:DB8::/32')).toEqual({
        kind: 'ipv6',
        canonical: '2001:db8::/32',
        prefix: 32,
      });
    });

    it('rejects malformed input', () => {
      expect(parseIpEntry('not-an-ip')).toBeNull();
      expect(parseIpEntry('999.0.0.1')).toBeNull();
      expect(parseIpEntry('203.0.113.42/40')).toBeNull();
      expect(parseIpEntry('2001:db8::/200')).toBeNull();
      expect(parseIpEntry('')).toBeNull();
    });
  });

  describe('cloudflareIpEntryValueSchema', () => {
    it('canonicalises on parse', () => {
      expect(cloudflareIpEntryValueSchema.parse('  203.0.113.42  ')).toBe(
        '203.0.113.42',
      );
      expect(cloudflareIpEntryValueSchema.parse('2001:DB8::1')).toBe(
        '2001:db8::1',
      );
    });

    it('rejects invalid input with a clear message', () => {
      const res = cloudflareIpEntryValueSchema.safeParse('not.an.ip');
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]?.message).toMatch(/IPv4 or IPv6/i);
      }
    });
  });

  describe('cloudflareAddEntrySchema', () => {
    it('requires entriesVersion', () => {
      const res = cloudflareAddEntrySchema.safeParse({
        ip: '203.0.113.42',
        description: 'Office',
      });
      expect(res.success).toBe(false);
    });

    it('round-trips a valid entry with description default', () => {
      const out = cloudflareAddEntrySchema.parse({
        ip: '203.0.113.42',
        entriesVersion: 1,
      });
      expect(out.ip).toBe('203.0.113.42');
      expect(out.description).toBe('');
      expect(out.entriesVersion).toBe(1);
    });
  });
});
