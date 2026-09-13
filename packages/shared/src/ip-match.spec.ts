import {
  describeCatchAllFamilyGap,
  findCatchAllFamilyGap,
  ipLimitKey,
  matchIpRule,
  normalizeIpForMatch,
  parseIpv6Cidr,
  type IpRuleLike,
} from './ip-match.js';

function rule(cidr: string, action: IpRuleLike['action'] = 'DENY', priority = 0): IpRuleLike {
  return { cidr, action, priority };
}

describe('matchIpRule — IPv4 (behavior unchanged by IPv6 support)', () => {
  it('matches a single IP by its exact text', () => {
    expect(matchIpRule('192.0.2.1', [rule('192.0.2.1')])).not.toBeNull();
    expect(matchIpRule('192.0.2.2', [rule('192.0.2.1')])).toBeNull();
  });

  it('matches a CIDR by prefix', () => {
    expect(matchIpRule('10.255.1.2', [rule('10.0.0.0/8')])).not.toBeNull();
    expect(matchIpRule('11.0.0.1', [rule('10.0.0.0/8')])).toBeNull();
    expect(matchIpRule('203.0.113.5', [rule('0.0.0.0/0')])).not.toBeNull();
    expect(matchIpRule('203.0.113.5', [rule('203.0.113.5/32')])).not.toBeNull();
  });

  it('keeps the single-IP comparison textual, as it always was', () => {
    // A zero-padded rule never matched the unpadded client address.
    expect(matchIpRule('10.0.0.1', [rule('010.0.0.1')])).toBeNull();
  });

  it('returns the first matching rule in the order given', () => {
    const allow = rule('10.0.0.0/8', 'ALLOW', 1);
    const deny = rule('10.0.0.0/8', 'DENY', 10);
    expect(matchIpRule('10.1.2.3', [allow, deny])).toBe(allow);
  });
});

describe('matchIpRule — IPv4-mapped clients', () => {
  const spellings = [
    '::ffff:192.0.2.1',
    '::FFFF:192.0.2.1',
    '::ffff:c000:201',
    '0:0:0:0:0:ffff:c000:0201',
  ];

  it.each(spellings)('matches %s against IPv4 rules', (ip) => {
    expect(matchIpRule(ip, [rule('192.0.2.0/24')])).not.toBeNull();
    expect(matchIpRule(ip, [rule('192.0.2.1')])).not.toBeNull();
  });

  it('does not match an IPv6 rule, not even ::/0', () => {
    expect(matchIpRule('::ffff:192.0.2.1', [rule('::/0')])).toBeNull();
  });
});

describe('matchIpRule — IPv6', () => {
  it('matches a single address in any spelling', () => {
    expect(matchIpRule('2001:DB8:0:0:0:0:0:1', [rule('2001:db8::1')])).not.toBeNull();
    expect(matchIpRule('2001:db8::1', [rule('2001:0DB8::0001')])).not.toBeNull();
  });

  it('reads a bare IPv6 rule as a /128', () => {
    expect(matchIpRule('2001:db8::2', [rule('2001:db8::1')])).toBeNull();
  });

  it('matches a CIDR by prefix', () => {
    expect(matchIpRule('2001:db8:ffff::1', [rule('2001:db8::/32')])).not.toBeNull();
    expect(matchIpRule('2001:db9::1', [rule('2001:db8::/32')])).toBeNull();
    expect(matchIpRule('2001:db8:1:2:3:4:5:6', [rule('2001:db8:1:2::/64')])).not.toBeNull();
    expect(matchIpRule('2001:db8:1:3::1', [rule('2001:db8:1:2::/64')])).toBeNull();
  });

  it('matches every IPv6 client with ::/0', () => {
    expect(matchIpRule('2606:4700::1111', [rule('::/0')])).not.toBeNull();
    expect(matchIpRule('::1', [rule('::/0')])).not.toBeNull();
  });
});

describe('matchIpRule — address families never cross', () => {
  it('does not match an IPv6 client with an IPv4 catch-all', () => {
    expect(matchIpRule('2001:db8::1', [rule('0.0.0.0/0')])).toBeNull();
  });

  it('does not match an IPv4 client with an IPv6 catch-all', () => {
    expect(matchIpRule('203.0.113.5', [rule('::/0')])).toBeNull();
  });
});

describe('matchIpRule — malformed input', () => {
  const catchAlls = [rule('0.0.0.0/0'), rule('::/0')];
  const badClients = [
    '',
    'unknown',
    '2001:db8::zz',
    'fe80::1%eth0',
    '[2001:db8::1]',
    '2001:db8::1/64',
    '1.2.3',
    '192.0.2.1:443',
  ];

  it.each(badClients)('matches no rule for the client value %j', (ip) => {
    expect(matchIpRule(ip, catchAlls)).toBeNull();
  });

  const badRules = [
    '2001:db8::/129',
    '2001:db8::/x',
    '2001:db8::/',
    'fe80::1%eth0',
    '[::]/0',
    '::ffff:192.0.2.0/120',
    'not-a-cidr',
  ];

  it.each(badRules)('never matches with the malformed rule %j', (cidr) => {
    expect(matchIpRule('2001:db8::1', [rule(cidr)])).toBeNull();
    expect(matchIpRule('192.0.2.1', [rule(cidr)])).toBeNull();
    expect(matchIpRule('fe80::1', [rule(cidr)])).toBeNull();
  });
});

describe('normalizeIpForMatch', () => {
  it('collapses IPv4-mapped spellings to IPv4', () => {
    expect(normalizeIpForMatch('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIpForMatch('0:0:0:0:0:FFFF:C000:0201')).toBe('192.0.2.1');
  });

  it('writes other IPv6 addresses in RFC 5952 form', () => {
    expect(normalizeIpForMatch('2001:0DB8:0000::0001')).toBe('2001:db8::1');
  });

  it('passes anything else through trimmed and lower-cased', () => {
    expect(normalizeIpForMatch(' 192.0.2.1 ')).toBe('192.0.2.1');
    expect(normalizeIpForMatch('Unknown')).toBe('unknown');
  });
});

describe('parseIpv6Cidr', () => {
  it('canonicalises the address and keeps the prefix', () => {
    expect(parseIpv6Cidr(' 2001:DB8:0::/032 ')).toMatchObject({
      ok: true,
      prefix: 32,
      canonical: '2001:db8::/32',
    });
  });

  it('reads a bare address as a /128 and keeps it bare', () => {
    expect(parseIpv6Cidr('2001:db8::1')).toMatchObject({
      ok: true,
      prefix: 128,
      canonical: '2001:db8::1',
    });
  });

  it('clears host bits in the network but keeps them in the canonical text', () => {
    const parsed = parseIpv6Cidr('2001:db8::1/32');
    expect(parsed.ok && parsed.network).toBe(0x20010db8000000000000000000000000n);
    expect(parsed.ok && parsed.canonical).toBe('2001:db8::1/32');
  });

  const rejections: Array<[string, string]> = [
    ['fe80::1%eth0', 'zone-id'],
    ['fe80::1%eth0/64', 'zone-id'],
    ['[2001:db8::1]', 'brackets-or-port'],
    ['[2001:db8::1]:443', 'brackets-or-port'],
    ['[2001:db8::]/32', 'brackets-or-port'],
    ['2001:db8::/129', 'prefix'],
    ['2001:db8::/', 'prefix'],
    ['2001:db8::/-1', 'prefix'],
    ['::ffff:192.0.2.1', 'ipv4-mapped'],
    ['::ffff:0:0/96', 'ipv4-mapped'],
    ['192.0.2.1', 'not-ipv6'],
    ['2001:db8::g', 'not-ipv6'],
    ['', 'not-ipv6'],
  ];

  it.each(rejections)('rejects %j as %s', (input, reason) => {
    expect(parseIpv6Cidr(input)).toEqual({ ok: false, reason });
  });
});

describe('findCatchAllFamilyGap', () => {
  it('flags an IPv4 DENY catch-all that has no IPv6 counterpart', () => {
    // The usual allowlist: ALLOW the office, then deny everything else.
    expect(
      findCatchAllFamilyGap([rule('203.0.113.0/24', 'ALLOW', 1), rule('0.0.0.0/0', 'DENY', 10)]),
    ).toEqual({ family: 'IPv4', uncoveredFamily: 'IPv6', cidr: '0.0.0.0/0' });
  });

  it('flags an IPv6 DENY catch-all that has no IPv4 counterpart', () => {
    expect(findCatchAllFamilyGap([rule('::/0', 'DENY', 10)])).toEqual({
      family: 'IPv6',
      uncoveredFamily: 'IPv4',
      cidr: '::/0',
    });
  });

  it('accepts a catch-all for the other family, whatever its action', () => {
    expect(
      findCatchAllFamilyGap([rule('0.0.0.0/0', 'DENY', 10), rule('::/0', 'DENY', 11)]),
    ).toBeNull();
    expect(
      findCatchAllFamilyGap([rule('0.0.0.0/0', 'DENY', 10), rule('::/0', 'ALLOW', 11)]),
    ).toBeNull();
  });

  it('ignores an ALLOW catch-all, which behaves like default-allow', () => {
    expect(findCatchAllFamilyGap([rule('0.0.0.0/0', 'ALLOW')])).toBeNull();
  });

  it('judges a family by its first catch-all in evaluation order', () => {
    expect(
      findCatchAllFamilyGap([rule('0.0.0.0/0', 'ALLOW', 1), rule('0.0.0.0/0', 'DENY', 2)]),
    ).toBeNull();
  });

  it('recognises any /0 spelling and ignores narrower rules', () => {
    expect(findCatchAllFamilyGap([rule('10.0.0.0/0')])?.family).toBe('IPv4');
    expect(findCatchAllFamilyGap([rule('0::0/0')])?.family).toBe('IPv6');
    expect(
      findCatchAllFamilyGap([rule('0.0.0.0/1'), rule('::/1'), rule('2001:db8::/32')]),
    ).toBeNull();
  });

  it('finds no gap in an empty rule set', () => {
    expect(findCatchAllFamilyGap([])).toBeNull();
  });

  it('describes the gap with the counterpart rule to add', () => {
    const text = describeCatchAllFamilyGap({
      family: 'IPv4',
      uncoveredFamily: 'IPv6',
      cidr: '0.0.0.0/0',
    });
    expect(text).toContain('The DENY rule 0.0.0.0/0');
    expect(text).toContain('IPv6 visitors');
    expect(text).toContain('Add a ::/0 rule');
  });
});

describe('ipLimitKey', () => {
  it('keeps IPv4 addresses exact', () => {
    expect(ipLimitKey('192.0.2.1')).toBe('192.0.2.1');
    expect(ipLimitKey('192.0.2.2')).toBe('192.0.2.2');
  });

  it('counts an IPv4-mapped client as its IPv4 address', () => {
    expect(ipLimitKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
  });

  it('groups every address in one IPv6 /64 under one key', () => {
    expect(ipLimitKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipLimitKey('2001:DB8:1:2:FFFF:FFFF:FFFF:FFFF')).toBe('2001:db8:1:2::/64');
    expect(ipLimitKey('2001:0db8:0001:0002:abcd::9')).toBe('2001:db8:1:2::/64');
  });

  it('keeps different /64 prefixes apart', () => {
    expect(ipLimitKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
  });

  it('passes values that are not IP addresses through', () => {
    expect(ipLimitKey('unknown')).toBe('unknown');
    expect(ipLimitKey('0.0.0.0')).toBe('0.0.0.0');
  });
});
