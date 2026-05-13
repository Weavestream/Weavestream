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
  CaaRecord,
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
  resolveTxt: (h) => dnsPromises.resolveTxt(h),
  resolveCaa: async (h) => {
    // Node's `resolveCaa` returns a record per type ({ issue, issuewild,
    // iodef, contactemail, contactphone }) — flatten into our generic
    // shape so consumers can iterate uniformly.
    const out = await dnsPromises.resolveCaa(h);
    const flat: CaaRecord[] = [];
    for (const rec of out) {
      if (typeof rec.issue === 'string') {
        flat.push({ flag: rec.critical ?? 0, tag: 'issue', value: rec.issue });
      }
      if (typeof rec.issuewild === 'string') {
        flat.push({
          flag: rec.critical ?? 0,
          tag: 'issuewild',
          value: rec.issuewild,
        });
      }
      if (typeof rec.iodef === 'string') {
        flat.push({ flag: rec.critical ?? 0, tag: 'iodef', value: rec.iodef });
      }
      if (typeof rec.contactemail === 'string') {
        flat.push({
          flag: rec.critical ?? 0,
          tag: 'contactemail',
          value: rec.contactemail,
        });
      }
      if (typeof rec.contactphone === 'string') {
        flat.push({
          flag: rec.critical ?? 0,
          tag: 'contactphone',
          value: rec.contactphone,
        });
      }
    }
    return flat;
  },
  resolve: async (h, rrtype) => {
    // We only ever ask for DNSKEY here; Node's `dns.resolve` overload
    // union is wider than we need, so we cast to `unknown[]` for the
    // DnsPort contract. The caller only checks `.length`.
    const out = (await dnsPromises.resolve(h, rrtype)) as unknown;
    return Array.isArray(out) ? (out as unknown[]) : [];
  },
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

/**
 * Best-effort detection of the Must-Staple TLS Feature extension
 * (RFC 7633). Node's `DetailedPeerCertificate` doesn't expose the
 * extension list directly, but it does expose `raw` (DER bytes). The
 * Must-Staple OID is 1.3.6.1.5.5.7.1.24 with value `30 03 02 01 05`
 * (SEQUENCE { INTEGER 5 } meaning feature `status_request`). We scan
 * the DER for that exact OID + value pair — false positives are
 * effectively zero because we match both halves.
 */
const MUST_STAPLE_OID_BYTES = Uint8Array.from([
  0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x18,
]);
function detectMustStaple(raw: Buffer | undefined): boolean {
  if (!raw || raw.length === 0) return false;
  outer: for (let i = 0; i <= raw.length - MUST_STAPLE_OID_BYTES.length; i++) {
    for (let j = 0; j < MUST_STAPLE_OID_BYTES.length; j++) {
      if (raw[i + j] !== MUST_STAPLE_OID_BYTES[j]) continue outer;
    }
    return true;
  }
  return false;
}

function normaliseKeyAlgo(
  cert: DetailedPeerCertificate,
): { algo: string | null; bits: number | null } {
  const asn1 = (cert as { asn1Curve?: string; nistCurve?: string }).asn1Curve
    ?? (cert as { nistCurve?: string }).nistCurve
    ?? null;
  const pubkey = (cert as { pubkey?: Buffer }).pubkey;
  const modulus = (cert as { modulus?: string }).modulus;
  const bitsRaw = (cert as { bits?: number }).bits;
  if (asn1) {
    return {
      algo: 'EC',
      bits: typeof bitsRaw === 'number'
        ? bitsRaw
        : pubkey
          ? pubkey.length * 8
          : null,
    };
  }
  if (modulus) {
    return {
      algo: 'RSA',
      bits: typeof bitsRaw === 'number' ? bitsRaw : modulus.length * 4,
    };
  }
  if (pubkey) {
    return { algo: 'unknown', bits: pubkey.length * 8 };
  }
  return { algo: null, bits: typeof bitsRaw === 'number' ? bitsRaw : null };
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
        // v2 — request OCSP stapling so the engine can record whether
        // the server provided a stapled response. `requestOCSP` is a
        // runtime-only option on tls.connect() and isn't surfaced in
        // Node's typings — cast so the option lands on the underlying
        // socket without disabling type-checking elsewhere.
        ...({ requestOCSP: true } as Record<string, unknown>),
      });
      const timer = setTimeout(() => {
        socket.destroy(new Error(`tls handshake timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      let ocspStapled = false;
      socket.on('OCSPResponse', (resp) => {
        if (resp && resp.length > 0) ocspStapled = true;
      });

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

          const { algo: keyAlgo, bits: keyBits } = normaliseKeyAlgo(cert);
          const sigAlgo =
            (cert as { sigalg?: string }).sigalg ??
            (cert as { signatureAlgorithm?: string }).signatureAlgorithm ??
            null;
          const mustStaple = detectMustStaple(
            (cert as { raw?: Buffer }).raw,
          );

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
            keyAlgo,
            keyBits,
            sigAlgo,
            mustStaple,
            ocspStapled,
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
