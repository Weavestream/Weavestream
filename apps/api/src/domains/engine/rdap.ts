/**
 * RDAP (Registration Data Access Protocol) lookups.
 *
 * IANA publishes a bootstrap registry at
 *   https://data.iana.org/rdap/dns.json
 * that maps TLDs to RDAP base URLs. We cache it in-process for
 * `RDAP_BOOTSTRAP_CACHE_HOURS` and fall back to a built-in minimal
 * registry if the fetch fails — this keeps us online for the common
 * TLDs (.com, .net, .org, .io) even when IANA is unreachable.
 *
 * The RDAP response schema is loosely specified (RFC 9083). Different
 * registries use different event `eventAction` strings, so we treat
 * the parser as best-effort and fall through to `whois:43` on any
 * failure to extract an `expiresAt`.
 */

import type { EnginePorts, WhoisSubResult } from './types.js';

const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

// Minimal fallback registry for when IANA itself is unreachable. These
// are the RDAP servers for the TLDs our customers use most — adding a
// TLD here means "we trust this URL" so keep it short.
const FALLBACK_REGISTRY: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/',
  net: 'https://rdap.verisign.com/net/v1/',
  org: 'https://rdap.publicinterestregistry.org/rdap/',
  io: 'https://rdap.identitydigital.services/rdap/',
  app: 'https://rdap.nic.google/',
  dev: 'https://rdap.nic.google/',
  ai: 'https://rdap.nic.ai/',
};

interface BootstrapEntry {
  tlds: string[];
  urls: string[];
}

interface CachedBootstrap {
  registry: Map<string, string>;
  fetchedAt: number;
}

let bootstrapCache: CachedBootstrap | null = null;

function buildRegistryFromBootstrap(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== 'object') return out;
  const services = (raw as { services?: unknown[] }).services;
  if (!Array.isArray(services)) return out;
  for (const svc of services) {
    // Each service entry is `[[tld, …], [url, …]]`.
    if (!Array.isArray(svc) || svc.length < 2) continue;
    const tlds = svc[0];
    const urls = svc[1];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    const url = urls.find(
      (u): u is string => typeof u === 'string' && u.startsWith('https://'),
    );
    if (!url) continue;
    for (const tld of tlds) {
      if (typeof tld !== 'string') continue;
      out.set(tld.toLowerCase(), url);
    }
  }
  return out;
}

export async function loadRdapRegistry(
  ports: EnginePorts,
  opts: { cacheMs: number; timeoutMs: number },
): Promise<Map<string, string>> {
  const now = Date.now();
  if (bootstrapCache && now - bootstrapCache.fetchedAt < opts.cacheMs) {
    return bootstrapCache.registry;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const res = await ports.fetch(IANA_BOOTSTRAP_URL, { signal: ac.signal });
    if (!res.ok) throw new Error(`bootstrap HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const parsed = buildRegistryFromBootstrap(body);
    if (parsed.size === 0) throw new Error('bootstrap registry empty');
    bootstrapCache = { registry: parsed, fetchedAt: now };
    return parsed;
  } catch {
    // Seed the cache with the fallback — this avoids hammering IANA
    // on every check when it's down. The cache window will still
    // expire, so we'll retry the real registry later.
    const fallback = new Map(Object.entries(FALLBACK_REGISTRY));
    bootstrapCache = { registry: fallback, fetchedAt: now };
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function extractTld(hostname: string): string | null {
  const parts = hostname.split('.');
  if (parts.length < 2) return null;
  return parts[parts.length - 1]!.toLowerCase();
}

function normaliseRdapBase(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Best-effort extraction of registrar + registration/expiry dates
 * from an RDAP response. RFC 9083 §5 defines the event actions but
 * registrars use wildly different labels; we look at several common
 * ones before giving up.
 *
 * v2 also extracts:
 *   - `status` codes (EPP lock state)
 *   - `nameservers` (for the WHOIS-vs-DNS NS reconciliation)
 *   - `secureDNS` (authoritative DNSSEC delegation evidence)
 */
function parseRdapResponse(raw: unknown): WhoisSubResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;

  const events = Array.isArray(body.events) ? body.events : [];
  let registeredAt: Date | null = null;
  let expiresAt: Date | null = null;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const action = (ev as Record<string, unknown>).eventAction;
    const date = (ev as Record<string, unknown>).eventDate;
    if (typeof action !== 'string' || typeof date !== 'string') continue;
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) continue;
    if (action === 'registration' && !registeredAt) registeredAt = parsed;
    if (
      (action === 'expiration' || action === 'expiry') &&
      !expiresAt
    ) {
      expiresAt = parsed;
    }
  }

  // Registrar is usually a contact entity of role `registrar`, with
  // the vcardArray carrying a `fn` (full name) entry. We don't need
  // the full vcard grammar — pluck the first string after `fn`.
  let registrar: string | null = null;
  const entities = Array.isArray(body.entities) ? body.entities : [];
  for (const ent of entities) {
    if (!ent || typeof ent !== 'object') continue;
    const roles = (ent as Record<string, unknown>).roles;
    if (!Array.isArray(roles) || !roles.includes('registrar')) continue;
    const vcard = (ent as Record<string, unknown>).vcardArray;
    if (!Array.isArray(vcard) || vcard.length < 2) continue;
    const entries = vcard[1];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 4) continue;
      if (entry[0] === 'fn' && typeof entry[3] === 'string') {
        registrar = entry[3];
        break;
      }
    }
    if (registrar) break;
  }

  // v2 — RDAP `status` is an array of EPP status code strings (RFC 9083
  // §5.6 + RFC 8056). Lower-case + de-dup; downstream consumers look
  // for `clienttransferprohibited` / `clienthold` / etc.
  const rawStatus = Array.isArray(body.status) ? body.status : [];
  const statusCodes = Array.from(
    new Set(
      rawStatus
        .filter((s): s is string => typeof s === 'string')
        // Some registries return "client transfer prohibited" with
        // spaces; normalise to the canonical no-space form.
        .map((s) => s.toLowerCase().replace(/\s+/g, '')),
    ),
  );
  const locked = statusCodes.some(
    (s) =>
      s === 'clienttransferprohibited' ||
      s === 'servertransferprohibited' ||
      s === 'clientdeleteprohibited' ||
      s === 'serverdeleteprohibited' ||
      s === 'clientupdateprohibited' ||
      s === 'serverupdateprohibited',
  );
  const hold = statusCodes.some(
    (s) => s === 'clienthold' || s === 'serverhold',
  );

  // v2 — `nameservers` is an array of objects with `ldhName`. RFC 9083
  // §5.2. Lower-case + strip trailing dot so `nsmatch` can compare
  // against the DNS NS answer cleanly.
  const rawNs = Array.isArray(body.nameservers) ? body.nameservers : [];
  const whoisNs = Array.from(
    new Set(
      rawNs
        .map((ns) => {
          if (!ns || typeof ns !== 'object') return null;
          const name = (ns as Record<string, unknown>).ldhName;
          if (typeof name !== 'string' || name.length === 0) return null;
          return name.toLowerCase().replace(/\.$/, '');
        })
        .filter((s): s is string => typeof s === 'string'),
    ),
  );

  // v2 — `secureDNS` block. The relevant fields are
  // `delegationSigned` (boolean) and `dsData` (array of DS records).
  // When present, this is the authoritative DNSSEC signal — much more
  // reliable than a DNSKEY probe against the host.
  let secureDns: WhoisSubResult['secureDns'] = null;
  const sec = body.secureDNS;
  if (sec && typeof sec === 'object') {
    const delegationSigned =
      (sec as Record<string, unknown>).delegationSigned === true;
    const dsData = (sec as Record<string, unknown>).dsData;
    const dsRecordCount = Array.isArray(dsData) ? dsData.length : 0;
    secureDns = { delegationSigned, dsRecordCount };
  }

  if (
    !expiresAt &&
    !registeredAt &&
    !registrar &&
    statusCodes.length === 0 &&
    whoisNs.length === 0 &&
    !secureDns
  ) {
    return null;
  }
  return {
    registrar,
    registeredAt,
    expiresAt,
    source: 'rdap',
    statusCodes,
    locked,
    hold,
    whoisNs,
    secureDns,
  };
}

export async function queryRdap(
  ports: EnginePorts,
  hostname: string,
  opts: { timeoutMs: number; cacheMs: number },
): Promise<WhoisSubResult | null> {
  const tld = extractTld(hostname);
  if (!tld) return null;
  const registry = await loadRdapRegistry(ports, opts);
  const base = registry.get(tld);
  if (!base) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const url = `${normaliseRdapBase(base)}domain/${encodeURIComponent(hostname)}`;
    const res = await ports.fetch(url, {
      signal: ac.signal,
      headers: { accept: 'application/rdap+json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return parseRdapResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// Test helpers — exported so spec files can reset the bootstrap cache
// between runs. Do NOT call from production code.
// ---------------------------------------------------------------------

export function __resetRdapCacheForTests(): void {
  bootstrapCache = null;
}
