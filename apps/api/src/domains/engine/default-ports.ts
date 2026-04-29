/**
 * Production `EnginePorts` wired to Node's real DNS/TLS/net stack and
 * the global `fetch`. Kept in its own module so test files never
 * accidentally import it — the engine modules only depend on the
 * injected `EnginePorts` interface.
 */

import dnsPromises from 'node:dns/promises';
import {
  connect as tlsConnect,
  type DetailedPeerCertificate,
  type PeerCertificate,
} from 'node:tls';
import { Socket } from 'node:net';
import { safeFetch } from '../../common/egress/safe-fetch.js';
import type {
  Clock,
  DnsPort,
  EnginePorts,
  TlsCertificateInfo,
  TlsPort,
  Whois43Port,
} from './types.js';

const WHOIS_PORT = 43;

const defaultClock: Clock = {
  now: () => new Date(),
};

const defaultDns: DnsPort = {
  resolve4: (h) => dnsPromises.resolve4(h),
  resolve6: (h) => dnsPromises.resolve6(h),
  resolveMx: (h) => dnsPromises.resolveMx(h),
  resolveNs: (h) => dnsPromises.resolveNs(h),
};

function stringifyName(
  name: PeerCertificate['issuer'] | DetailedPeerCertificate['issuer'],
): string | null {
  if (!name || typeof name !== 'object') return null;
  const parts: string[] = [];
  for (const [key, val] of Object.entries(name)) {
    if (typeof val === 'string') parts.push(`${key}=${val}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function parseSubjectAltNames(san: string | undefined): string[] {
  if (!san) return [];
  return san
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => {
      const idx = entry.indexOf(':');
      return idx === -1 ? entry : entry.slice(idx + 1);
    })
    .filter((entry) => entry.length > 0);
}

const defaultTls: TlsPort = {
  probe(hostname, port, timeoutMs) {
    return new Promise<TlsCertificateInfo>((resolve, reject) => {
      const socket = tlsConnect({
        host: hostname,
        port,
        servername: hostname,
        timeout: timeoutMs,
        // Intentional: this is a certificate observability probe, not a
        // trust-establishing client. We must be able to handshake with
        // expired, self-signed, hostname-mismatched, and untrusted-CA
        // certs in order to *report* on them — `rejectUnauthorized:
        // true` aborts before the cert is exposed and we'd lose the
        // very signal we're trying to monitor. The trust verdict from
        // Node's validator is captured separately below via
        // `socket.authorized` / `socket.authorizationError` and
        // surfaced in the result so callers can still alert on it. No
        // application data is sent over the socket.
        rejectUnauthorized: false,
      });
      const timer = setTimeout(() => {
        socket.destroy(new Error(`tls handshake timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.once('secureConnect', () => {
        clearTimeout(timer);
        try {
          const cert: DetailedPeerCertificate = socket.getPeerCertificate(true);
          let chainLength = 0;
          let current: DetailedPeerCertificate | undefined = cert;
          const seenFingerprints = new Set<string>();
          while (
            current &&
            current.fingerprint &&
            !seenFingerprints.has(current.fingerprint)
          ) {
            seenFingerprints.add(current.fingerprint);
            chainLength += 1;
            const next: DetailedPeerCertificate | undefined =
              current.issuerCertificate;
            if (!next || next === current) break;
            current = next;
          }

          const authorized = socket.authorized === true;
          const rawAuthError = (socket as { authorizationError?: unknown })
            .authorizationError;
          const authorizationError = authorized
            ? null
            : rawAuthError instanceof Error
              ? rawAuthError.message
              : typeof rawAuthError === 'string' && rawAuthError.length > 0
                ? rawAuthError
                : null;

          const info: TlsCertificateInfo = {
            validFrom: cert.valid_from ?? null,
            validTo: cert.valid_to ?? null,
            issuer: stringifyName(cert.issuer),
            subjectAltNames: parseSubjectAltNames(
              (cert as { subjectaltname?: string }).subjectaltname,
            ),
            chainLength,
            protocol: socket.getProtocol(),
            authorized,
            authorizationError,
          };
          socket.end();
          resolve(info);
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      });

      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once('timeout', () => {
        clearTimeout(timer);
        socket.destroy(new Error(`tls connect timeout after ${timeoutMs}ms`));
      });
    });
  },
};

const defaultWhois43: Whois43Port = {
  query(server, hostname, timeoutMs) {
    return new Promise<string>((resolve, reject) => {
      const socket = new Socket();
      socket.setEncoding('utf8');
      socket.setTimeout(timeoutMs);
      const chunks: string[] = [];

      socket.on('data', (chunk) => chunks.push(chunk.toString()));
      socket.on('end', () => resolve(chunks.join('')));
      socket.on('timeout', () => {
        socket.destroy(new Error(`whois timeout after ${timeoutMs}ms`));
      });
      socket.on('error', reject);

      socket.connect(WHOIS_PORT, server, () => {
        socket.write(`${hostname}\r\n`);
      });
    });
  },
};

export function createDefaultPorts(): EnginePorts {
  return {
    clock: defaultClock,
    dns: defaultDns,
    tls: defaultTls,
    whois43: defaultWhois43,
    fetch: async (url, init) => {
      // The RDAP + bootstrap callers wrap us in their own
      // `AbortController` + setTimeout pair, so the caller-supplied
      // `signal` is the operative deadline. We still pass a generous
      // hard ceiling to safeFetch so a stuck connection can't outlive
      // the caller's signal cleanup. The egress guard validates the
      // resolved IPs first and refuses to dial private addresses.
      const res = await safeFetch(url, {
        ...(init ?? {}),
        timeoutMs: 60_000,
      });
      return {
        ok: res.ok,
        status: res.status,
        json: () => res.json(),
        text: () => res.text(),
      };
    },
  };
}
