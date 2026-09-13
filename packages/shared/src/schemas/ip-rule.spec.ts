import { ipRuleCidrSchema, ipRuleInputSchema, ipRulePatchSchema } from './ip-rule.js';

function firstIssue(input: string): string | undefined {
  const result = ipRuleCidrSchema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('ipRuleCidrSchema', () => {
  it.each(['192.168.1.1', '10.0.0.0/8', '0.0.0.0/0', '255.255.255.255/32'])(
    'keeps the IPv4 value %s exactly',
    (value) => {
      expect(ipRuleCidrSchema.parse(value)).toBe(value);
    },
  );

  it('trims IPv4 input as before', () => {
    expect(ipRuleCidrSchema.parse(' 10.0.0.0/8 ')).toBe('10.0.0.0/8');
  });

  const ipv6: Array<[string, string]> = [
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:db8::/32', '2001:db8::/32'],
    ['2001:DB8:0:0::/48', '2001:db8::/48'],
    ['0::0/0', '::/0'],
    ['::/0', '::/0'],
  ];
  it.each(ipv6)('accepts the IPv6 value %s and stores %s', (input, stored) => {
    expect(ipRuleCidrSchema.parse(input)).toBe(stored);
  });

  const rejected: Array<[string, RegExp]> = [
    ['', /^Enter an IP address or CIDR range$/],
    ['not-an-ip', /IPv4 or IPv6 address or CIDR range/],
    ['256.0.0.1', /IPv4 or IPv6 address or CIDR range/],
    ['10.0.0.0/33', /IPv4 prefix length .* 0 to 32/],
    ['fe80::1%eth0', /zone ID/],
    ['[2001:db8::1]:443', /without brackets or a port/],
    ['2001:db8::/129', /IPv6 prefix length .* 0 to 128/],
    ['::ffff:192.0.2.1', /plain IPv4 form/],
    ['a'.repeat(50), /^Too long/],
  ];
  it.each(rejected)('rejects %j with a message that says what to fix', (input, message) => {
    expect(firstIssue(input)).toMatch(message);
  });

  it('reports one issue, not two, for an empty value', () => {
    const result = ipRuleCidrSchema.safeParse('');
    expect(result.success ? 0 : result.error.issues.length).toBe(1);
  });
});

describe('ipRuleInputSchema and ipRulePatchSchema', () => {
  it('store an IPv6 CIDR in canonical form', () => {
    expect(ipRuleInputSchema.parse({ cidr: '2001:DB8::/32', action: 'DENY' }).cidr).toBe(
      '2001:db8::/32',
    );
    expect(ipRulePatchSchema.parse({ cidr: '2001:DB8::/32' }).cidr).toBe('2001:db8::/32');
  });
});
