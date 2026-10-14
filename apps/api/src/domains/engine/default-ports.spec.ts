import { createServer, type Server } from 'node:net';
import { createDefaultPorts } from './default-ports.js';
import {
  EgressBlockedError,
  resetEgressGuardForTests,
  setDefaultResolveForTests,
} from '../../common/egress/safe-fetch.js';

/**
 * The production TLS and WHOIS ports open raw sockets, so they cannot use
 * `safeFetch`. Monitored hostnames can arrive from synced provider feeds
 * whose DNS a customer tenant admin controls; these specs pin that a name
 * resolving to a private address is refused before any socket opens.
 */
describe('createDefaultPorts — raw socket egress guard', () => {
  afterEach(() => resetEgressGuardForTests());

  it('refuses a TLS probe to a hostname that resolves to loopback', async () => {
    // A real listener on loopback: the probe must not reach it.
    let connections = 0;
    const server: Server = createServer((sock) => {
      connections += 1;
      sock.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    setDefaultResolveForTests(async () => ['127.0.0.1']);
    try {
      await expect(
        createDefaultPorts().tls.probe('tenant-verified.example.test', port, 2_000),
      ).rejects.toBeInstanceOf(EgressBlockedError);
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refuses a TLS probe to shorthand IPv4 that the system resolver maps to loopback', async () => {
    // `127.1` passes the feed hostname schema; with the real resolver it is
    // 127.0.0.1 and must be refused before any socket opens.
    let connections = 0;
    const server: Server = createServer((sock) => {
      connections += 1;
      sock.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      await expect(createDefaultPorts().tls.probe('127.1', port, 2_000)).rejects.toBeInstanceOf(
        EgressBlockedError,
      );
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.each(['10.0.0.5', '169.254.169.254', '::1'])(
    'refuses a WHOIS query to a server that resolves to %s',
    async (ip) => {
      setDefaultResolveForTests(async () => [ip]);
      await expect(
        createDefaultPorts().whois43.query('whois.referral.example', 'example.com', 2_000),
      ).rejects.toBeInstanceOf(EgressBlockedError);
    },
  );

  it('refuses a WHOIS referral that names a private IP literal', async () => {
    const resolve = jest.fn(async () => ['93.184.216.34']);
    setDefaultResolveForTests(resolve);
    await expect(
      createDefaultPorts().whois43.query('127.0.0.1', 'example.com', 2_000),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(resolve).not.toHaveBeenCalled();
  });
});
