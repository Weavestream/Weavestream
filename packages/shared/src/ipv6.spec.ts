import { bigIntToIpv6, ipv6Mask, ipv6ToBigInt } from './ipv6.js';

describe('ipv6ToBigInt', () => {
  const DOC_1 = 0x20010db8000000000000000000000001n; // 2001:db8::1

  it('parses compressed, full, and mixed-case spellings to one value', () => {
    expect(ipv6ToBigInt('2001:db8::1')).toBe(DOC_1);
    expect(ipv6ToBigInt('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe(DOC_1);
    expect(ipv6ToBigInt('2001:DB8:0:0::1')).toBe(DOC_1);
  });

  it('parses the unspecified and loopback addresses', () => {
    expect(ipv6ToBigInt('::')).toBe(0n);
    expect(ipv6ToBigInt('::1')).toBe(1n);
  });

  it('parses an embedded IPv4 tail', () => {
    expect(ipv6ToBigInt('::ffff:192.0.2.1')).toBe(0xffffc0000201n);
  });

  const rejected: Array<[string, string]> = [
    ['a zone ID', 'fe80::1%eth0'],
    ['brackets', '[2001:db8::1]'],
    ['a bracketed port', '[2001:db8::1]:443'],
    ['a prefix length', '2001:db8::/32'],
    ['text that would steer the URL parser', '::1]:80/[::2'],
    ['two compressions', '2001::db8::1'],
    ['nine groups', '1:2:3:4:5:6:7:8:9'],
    ['a five-digit group', '2001:db8::10000'],
    ['an out-of-range IPv4 tail', '::ffff:192.0.2.256'],
    ['plain IPv4', '192.0.2.1'],
    ['a non-hex letter', '2001:db8::g'],
    ['surrounding whitespace', ' ::1'],
    ['an empty string', ''],
  ];
  it.each(rejected)('rejects %s', (_label, input) => {
    expect(ipv6ToBigInt(input)).toBeNull();
  });
});

describe('ipv6Mask', () => {
  it('covers exactly the leading prefix bits', () => {
    expect(ipv6Mask(0)).toBe(0n);
    expect(ipv6Mask(64)).toBe(0xffffffffffffffff0000000000000000n);
    expect(ipv6Mask(128)).toBe((1n << 128n) - 1n);
  });
});

describe('bigIntToIpv6', () => {
  const cases: Array<[bigint, string]> = [
    [0n, '::'],
    [1n, '::1'],
    [0x20010db8000000000000000000000001n, '2001:db8::1'],
    // The longest run of zero groups is compressed, not the first.
    [0x20010db8000000010000000000000001n, '2001:db8:0:1::1'],
    // Of two equally long runs, the first is compressed.
    [0x20010db8000000000001000000000001n, '2001:db8::1:0:0:1'],
    // A single zero group stays written out.
    [0x20010db8000000010001000100010001n, '2001:db8:0:1:1:1:1:1'],
  ];
  it.each(cases)('renders %s as %s', (value, text) => {
    expect(bigIntToIpv6(value)).toBe(text);
  });

  it('round-trips any spelling to the canonical form', () => {
    expect(bigIntToIpv6(ipv6ToBigInt('2001:0DB8:0000::0001')!)).toBe('2001:db8::1');
  });
});
