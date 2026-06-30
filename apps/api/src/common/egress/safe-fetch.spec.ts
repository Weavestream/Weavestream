import {
  configureEgressGuard,
  EgressBlockedError,
  resetEgressGuardForTests,
  safeFetch,
  type EgressBlockedInfo,
} from './safe-fetch.js';
import {
  __testing,
  ipMatchesAny,
  parseCidr,
  parseCidrList,
} from './private-cidrs.js';

describe('safeFetch — egress guard', () => {
  const okFetch = (() =>
    new Response('hello', { status: 200 })) as unknown as typeof fetch;
  const resolveTo = (ips: readonly string[]) => async () => ips;

  afterEach(() => resetEgressGuardForTests());

  describe('protocol + URL validation', () => {
    it('rejects non-http(s) URLs', async () => {
      await expect(
        safeFetch('file:///etc/passwd', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
          resolve: resolveTo(['203.0.113.5']),
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });

    it('rejects malformed URLs', async () => {
      await expect(
        safeFetch('not a url', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
          resolve: resolveTo(['203.0.113.5']),
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });
  });

  describe('private network blocking (defaults)', () => {
    const cases: Array<[string, string]> = [
      ['loopback IPv4', '127.0.0.1'],
      ['loopback IPv6', '::1'],
      ['RFC1918 10.x', '10.0.5.7'],
      ['RFC1918 172.16/12', '172.20.0.1'],
      ['RFC1918 192.168/16', '192.168.5.10'],
      ['link-local 169.254', '169.254.1.1'],
      ['AWS metadata', '169.254.169.254'],
      ['CGNAT 100.64/10', '100.96.0.1'],
      ['IPv6 unique-local', 'fc00::1'],
      ['IPv6 link-local', 'fe80::1'],
      ['multicast IPv4', '224.0.0.1'],
      ['multicast IPv6', 'ff00::1'],
    ];
    for (const [label, ip] of cases) {
      it(`blocks ${label} (${ip})`, async () => {
        await expect(
          safeFetch('https://attacker.example/probe', {
            timeoutMs: 1000,
            fetchImpl: okFetch,
            resolve: resolveTo([ip]),
          }),
        ).rejects.toBeInstanceOf(EgressBlockedError);
      });
    }

    it('blocks even when only ONE of multiple A records is private', async () => {
      // The classic DNS-rebinding shape: one public IP + one private IP.
      // We block conservatively so a misbehaving resolver can't slip a
      // private address through.
      await expect(
        safeFetch('https://attacker.example/probe', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
          resolve: resolveTo(['203.0.113.5', '127.0.0.1']),
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });

    it('allows public IPs through', async () => {
      const res = await safeFetch('https://api.example.com/v1', {
        timeoutMs: 1000,
        fetchImpl: okFetch,
        resolve: resolveTo(['8.8.8.8']),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('IP literals', () => {
    it('blocks IP-literal hostnames against the same blocklist', async () => {
      await expect(
        safeFetch('http://127.0.0.1:5432/probe', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });

    it('blocks IPv6 metadata literal', async () => {
      await expect(
        safeFetch('http://[::1]/health', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });
  });

  describe('operator overrides', () => {
    it('EGRESS_ALLOW_PRIVATE_NETWORKS=true bypasses the blocklist', async () => {
      configureEgressGuard({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: '',
      });
      const res = await safeFetch('http://10.0.0.1/api', {
        timeoutMs: 1000,
        fetchImpl: okFetch,
      });
      expect(res.status).toBe(200);
    });

    it('EGRESS_ALLOWED_PRIVATE_CIDRS punches a surgical hole', async () => {
      configureEgressGuard({
        allowPrivateNetworks: false,
        allowedPrivateCidrs: '10.42.0.0/16',
      });
      const res = await safeFetch('https://rmm.lan/api', {
        timeoutMs: 1000,
        fetchImpl: okFetch,
        resolve: resolveTo(['10.42.5.7']),
      });
      expect(res.status).toBe(200);
    });

    it('CIDRs outside the allow-list are still blocked', async () => {
      configureEgressGuard({
        allowPrivateNetworks: false,
        allowedPrivateCidrs: '10.42.0.0/16',
      });
      await expect(
        safeFetch('https://rmm.lan/api', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
          resolve: resolveTo(['10.99.0.5']),
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });

    it('per-call allowPrivateNetworks: true bypasses the blocklist', async () => {
      const res = await safeFetch('http://127.0.0.1:9000/test', {
        timeoutMs: 1000,
        fetchImpl: okFetch,
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('telemetry', () => {
    it('invokes onBlocked with redacted URL + reason on every block', async () => {
      const blocks: EgressBlockedInfo[] = [];
      configureEgressGuard({
        allowPrivateNetworks: false,
        allowedPrivateCidrs: '',
        onBlocked: (info) => blocks.push(info),
      });
      await expect(
        safeFetch('http://user:pass@127.0.0.1/probe', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
      expect(blocks).toHaveLength(1);
      const block = blocks[0]!;
      expect(block.reason).toBe('private_ip_blocked');
      expect(block.matchedCidr).toBe('127.0.0.0/8');
      expect(block.url).not.toContain('user:pass');
    });

    it('strips userinfo and the query string from the blocked URL', async () => {
      // The blocked URL lands in the durable, append-only audit log, so it
      // must never carry credentials — neither `user:pass@` userinfo nor
      // query-string secrets (API keys, signed-URL tokens, webhook creds).
      const blocks: EgressBlockedInfo[] = [];
      configureEgressGuard({
        allowPrivateNetworks: false,
        allowedPrivateCidrs: '',
        onBlocked: (info) => blocks.push(info),
      });
      await expect(
        safeFetch('http://user:pass@127.0.0.1/probe?token=secret&key=abc', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.url).toBe('http://127.0.0.1/probe');
    });

    it('telemetry that throws does not break the block', async () => {
      configureEgressGuard({
        allowPrivateNetworks: false,
        allowedPrivateCidrs: '',
        onBlocked: () => {
          throw new Error('audit-log down');
        },
      });
      await expect(
        safeFetch('http://10.0.0.1/probe', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });
  });

  describe('response size cap', () => {
    it('aborts the body stream when maxResponseBytes is exceeded', async () => {
      const oversized = (() =>
        new Response('a'.repeat(10_000), { status: 200 })) as unknown as typeof fetch;
      const res = await safeFetch('https://api.example.com/big', {
        timeoutMs: 1000,
        fetchImpl: oversized,
        resolve: resolveTo(['8.8.8.8']),
        maxResponseBytes: 100,
      });
      await expect(res.text()).rejects.toThrow(/exceeded/);
    });

    it('lets compliant bodies through unchanged', async () => {
      const small = (() =>
        new Response('compact', { status: 200 })) as unknown as typeof fetch;
      const res = await safeFetch('https://api.example.com/small', {
        timeoutMs: 1000,
        fetchImpl: small,
        resolve: resolveTo(['8.8.8.8']),
        maxResponseBytes: 1_000,
      });
      await expect(res.text()).resolves.toBe('compact');
    });
  });

  describe('redirect re-validation', () => {
    // Builds a `fetch` stub that returns the queued responses in order.
    const queueFetch = (responses: Response[]) => {
      let i = 0;
      return ((_url: string, _init?: RequestInit) => {
        const next = responses[i++];
        if (!next) throw new Error('queueFetch exhausted');
        return Promise.resolve(next);
      }) as unknown as typeof fetch;
    };

    it('follows a redirect when both hops resolve to public IPs', async () => {
      const fetchImpl = queueFetch([
        new Response(null, {
          status: 302,
          headers: { location: 'https://final.example/done' },
        }),
        new Response('ok', { status: 200 }),
      ]);
      const res = await safeFetch('https://start.example/go', {
        timeoutMs: 1000,
        fetchImpl,
        // Both hostnames resolve to the same public IP for the test.
        resolve: resolveTo(['8.8.8.8']),
      });
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe('ok');
    });

    it('blocks a redirect that points at a private IP', async () => {
      // First hop returns a 302 → http://internal.example/. The resolve
      // stub returns a public IP for the first lookup and a private IP
      // for the destination, so the second safeFetch entry must reject
      // with EgressBlockedError instead of performing the request.
      let call = 0;
      const fetchImpl = (() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'http://internal.example/admin' },
          }),
        )) as unknown as typeof fetch;
      const resolve = async () => {
        call += 1;
        return call === 1 ? ['8.8.8.8'] : ['10.0.0.1'];
      };
      await expect(
        safeFetch('https://public.example/login', {
          timeoutMs: 1000,
          fetchImpl,
          resolve,
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });

    it('caps the redirect chain at MAX_REDIRECT_HOPS', async () => {
      // Endless redirect to a new public URL each hop. The guard must
      // abort the chain rather than spin forever.
      let hop = 0;
      const fetchImpl = (() => {
        hop += 1;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://hop${hop}.example/next` },
          }),
        );
      }) as unknown as typeof fetch;
      await expect(
        safeFetch('https://hop0.example/start', {
          timeoutMs: 1000,
          fetchImpl,
          resolve: resolveTo(['8.8.8.8']),
        }),
      ).rejects.toThrow(/redirect hops/);
    });

    it('returns the 3xx response when caller opts out via redirect: manual', async () => {
      const fetchImpl = queueFetch([
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/' },
        }),
      ]);
      const res = await safeFetch('https://start.example/go', {
        timeoutMs: 1000,
        fetchImpl,
        resolve: resolveTo(['8.8.8.8']),
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://elsewhere.example/');
    });
  });

  describe('DNS resolution failures', () => {
    it('surfaces a clean error when the resolver throws', async () => {
      await expect(
        safeFetch('https://nonexistent.invalid/probe', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
          resolve: async () => {
            throw new Error('ENOTFOUND');
          },
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });

    it('surfaces a clean error on empty resolver result', async () => {
      await expect(
        safeFetch('https://nonexistent.invalid/probe', {
          timeoutMs: 1000,
          fetchImpl: okFetch,
          resolve: resolveTo([]),
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    });
  });
});

describe('parseCidr / ipMatchesAny', () => {
  it('parses an IPv4 host route as /32', () => {
    expect(parseCidr('203.0.113.5').prefix).toBe(32);
  });

  it('rejects out-of-range IPv4 prefixes', () => {
    expect(() => parseCidr('10.0.0.0/33')).toThrow();
  });

  it('rejects out-of-range IPv6 prefixes', () => {
    expect(() => parseCidr('::1/200')).toThrow();
  });

  it('matches hosts inside a /16', () => {
    const cidrs = parseCidrList('10.42.0.0/16');
    expect(ipMatchesAny('10.42.5.7', cidrs)).not.toBeNull();
    expect(ipMatchesAny('10.43.5.7', cidrs)).toBeNull();
  });

  it('matches IPv6 unique-local', () => {
    const cidrs = parseCidrList('fc00::/7');
    expect(ipMatchesAny('fd00::1', cidrs)).not.toBeNull();
    expect(ipMatchesAny('2001:db8::1', cidrs)).toBeNull();
  });

  it('parseCidrList tolerates whitespace + trailing commas', () => {
    expect(
      parseCidrList(' 10.0.0.0/8 , 192.168.0.0/16 ,').map((c) => c.raw),
    ).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('parseCidrList returns [] for empty input', () => {
    expect(parseCidrList('')).toEqual([]);
    expect(parseCidrList(null)).toEqual([]);
    expect(parseCidrList(undefined)).toEqual([]);
  });

  describe('IPv4 arithmetic', () => {
    const { ipv4ToInt, ipv4Mask } = __testing;
    it('encodes 0.0.0.0 / 255.255.255.255', () => {
      expect(ipv4ToInt('0.0.0.0')).toBe(0);
      expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
    });
    it('rejects garbage', () => {
      expect(ipv4ToInt('256.0.0.0')).toBeNull();
      expect(ipv4ToInt('foo')).toBeNull();
      expect(ipv4ToInt('1.2.3')).toBeNull();
    });
    it('builds the correct mask', () => {
      expect(ipv4Mask(0)).toBe(0);
      expect(ipv4Mask(8)).toBe(0xff000000);
      expect(ipv4Mask(32)).toBe(0xffffffff);
    });
  });
});
