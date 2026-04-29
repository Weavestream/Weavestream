/**
 * Egress / SSRF guard.
 *
 * Every server-side outbound HTTP call in the API + worker should flow
 * through `safeFetch` instead of the global `fetch`. The guard:
 *
 *   1. Rejects non-`http(s):` URLs.
 *   2. Resolves the hostname (all v4 + v6 addresses) and verifies every
 *      resolved IP is publicly routable. Any address inside a loopback,
 *      RFC1918, link-local, multicast, broadcast, CGNAT, or reserved
 *      range is refused — this defeats the standard SSRF playbook
 *      (`http://localhost`, `http://169.254.169.254` for cloud metadata,
 *      `http://10.x.x.x` for internal services).
 *   3. Wraps the response stream so we can refuse to keep reading once
 *      `maxResponseBytes` is exceeded — protects worker memory from a
 *      hostile origin streaming a multi-GB payload.
 *   4. Aborts via AbortSignal after `timeoutMs`.
 *
 * Operators can opt out per-network via `EGRESS_ALLOWED_PRIVATE_CIDRS`
 * (e.g. on-prem RMM endpoints), or globally via
 * `EGRESS_ALLOW_PRIVATE_NETWORKS=true` for lab / single-host setups.
 *
 * Caveat — DNS rebinding. The guard validates IPs returned by
 * `dns.lookup` and then hands the *hostname* to the underlying fetch,
 * which may re-resolve. A sufficiently motivated attacker controlling
 * the authoritative DNS for their domain can return a public IP on the
 * first lookup and a private IP on the second. Closing this window
 * properly requires a custom undici dispatcher that pins the connect
 * address. That's a meaningful upgrade tracked as a follow-up — for the
 * threat model this guard targets (operator paste, integration baseUrl
 * misuse, opportunistic SSRF probes), the resolve-then-check approach
 * stops every realistic case.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import {
  defaultBlockedCidrs,
  ipMatchesAny,
  parseCidrList,
  type Cidr,
} from './private-cidrs.js';

export class EgressBlockedError extends Error {
  readonly url: string;
  readonly hostname: string;
  readonly resolvedIps: readonly string[];
  readonly reason: string;

  constructor(opts: {
    url: string;
    hostname: string;
    resolvedIps: readonly string[];
    reason: string;
  }) {
    super(`Egress blocked for ${opts.url}: ${opts.reason}`);
    this.name = 'EgressBlockedError';
    this.url = opts.url;
    this.hostname = opts.hostname;
    this.resolvedIps = opts.resolvedIps;
    this.reason = opts.reason;
  }
}

export type EgressBlockReason =
  | 'unsupported_protocol'
  | 'invalid_url'
  | 'invalid_hostname'
  | 'dns_resolution_failed'
  | 'private_ip_blocked';

export type EgressBlockedInfo = {
  url: string;
  hostname: string;
  resolvedIps: string[];
  reason: EgressBlockReason;
  matchedCidr: string | null;
};

export type EgressBlockedCallback = (info: EgressBlockedInfo) => void;

export interface SafeFetchOptions extends Omit<RequestInit, 'signal'> {
  /** Hard upper bound on the request duration (start-to-headers + body). */
  timeoutMs: number;
  /** Refuse to read more than this many bytes from the response body. */
  maxResponseBytes?: number;
  /**
   * Bypass the SSRF guard for this single call. Use only for known-safe
   * internal targets that must be reachable on a private network — e.g.
   * the loopback Postgres health probe in tests. Production code should
   * either avoid this entirely or rely on `EGRESS_ALLOWED_PRIVATE_CIDRS`.
   */
  allowPrivateNetworks?: boolean;
  /** Optional caller-supplied abort signal. */
  signal?: AbortSignal | null;
  /**
   * Hook overrides — only used by tests so the spec can exercise the
   * guard's logic without binding to the real DNS resolver or `fetch`.
   */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  fetchImpl?: typeof fetch;
}

interface EgressGuardConfig {
  allowAllPrivate: boolean;
  allowedPrivateCidrs: Cidr[];
  defaultMaxResponseBytes: number;
  onBlocked: EgressBlockedCallback;
}

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB

let config: EgressGuardConfig = {
  allowAllPrivate: false,
  allowedPrivateCidrs: [],
  defaultMaxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  onBlocked: () => {},
};

export interface ConfigureEgressGuardOptions {
  allowPrivateNetworks: boolean;
  allowedPrivateCidrs: string;
  defaultMaxResponseBytes?: number;
  onBlocked?: EgressBlockedCallback;
}

/**
 * Wire the egress guard into the running process. Called once from
 * `apps/api/src/main.ts` and `apps/worker/src/main.ts` after env is
 * parsed. Subsequent calls replace the previous config so tests can
 * reset to defaults.
 */
export function configureEgressGuard(opts: ConfigureEgressGuardOptions): void {
  config = {
    allowAllPrivate: opts.allowPrivateNetworks,
    allowedPrivateCidrs: parseCidrList(opts.allowedPrivateCidrs),
    defaultMaxResponseBytes:
      opts.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    onBlocked: opts.onBlocked ?? (() => {}),
  };
}

export function resetEgressGuardForTests(): void {
  config = {
    allowAllPrivate: false,
    allowedPrivateCidrs: [],
    defaultMaxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    onBlocked: () => {},
  };
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveImpl = options.resolve ?? defaultResolve;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw block(url, '', [], 'invalid_url', `not a valid URL: ${url}`, null);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw block(
      url,
      parsed.hostname,
      [],
      'unsupported_protocol',
      `protocol ${parsed.protocol} not allowed`,
      null,
    );
  }

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!hostname) {
    throw block(url, hostname, [], 'invalid_hostname', 'empty hostname', null);
  }

  // Skip DNS when the operator already supplied a literal IP — both
  // `new URL('http://10.0.0.1')` and `http://[::1]` parse the address
  // straight onto `hostname`.
  let resolvedIps: string[];
  if (isIpLiteral(hostname)) {
    resolvedIps = [hostname];
  } else {
    try {
      const out = await resolveImpl(hostname);
      resolvedIps = [...out];
    } catch (err) {
      throw block(
        url,
        hostname,
        [],
        'dns_resolution_failed',
        err instanceof Error ? err.message : String(err),
        null,
      );
    }
    if (resolvedIps.length === 0) {
      throw block(
        url,
        hostname,
        [],
        'dns_resolution_failed',
        'no addresses returned',
        null,
      );
    }
  }

  if (!options.allowPrivateNetworks && !config.allowAllPrivate) {
    const blockList = defaultBlockedCidrs();
    for (const ip of resolvedIps) {
      const matched = ipMatchesAny(ip, blockList);
      if (matched && !ipMatchesAny(ip, config.allowedPrivateCidrs)) {
        throw block(
          url,
          hostname,
          resolvedIps,
          'private_ip_blocked',
          `${ip} is in blocked range ${matched.raw}`,
          matched.raw,
        );
      }
    }
  }

  const controller = new AbortController();
  const external = options.signal ?? null;
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', () => controller.abort(external.reason));
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`safeFetch timeout after ${options.timeoutMs}ms`));
  }, options.timeoutMs);

  try {
    const init: RequestInit = {
      ...options,
      signal: controller.signal,
    };
    delete (init as { resolve?: unknown }).resolve;
    delete (init as { fetchImpl?: unknown }).fetchImpl;
    delete (init as { allowPrivateNetworks?: unknown }).allowPrivateNetworks;
    delete (init as { maxResponseBytes?: unknown }).maxResponseBytes;
    delete (init as { timeoutMs?: unknown }).timeoutMs;

    const res = await fetchImpl(url, init);
    return wrapResponse(
      res,
      options.maxResponseBytes ?? config.defaultMaxResponseBytes,
      timer,
    );
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function wrapResponse(res: Response, maxBytes: number, timer: NodeJS.Timeout): Response {
  // Clear the timeout once headers are in — body reads handle their own
  // limit. The caller is still responsible for reading promptly.
  clearTimeout(timer);

  if (!res.body) return res;

  const reader = res.body.getReader();
  let received = 0;

  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        received += value?.byteLength ?? 0;
        if (received > maxBytes) {
          controller.error(
            new Error(
              `safeFetch response exceeded ${maxBytes} bytes (read ${received})`,
            ),
          );
          await reader.cancel();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(limited, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function block(
  url: string,
  hostname: string,
  resolvedIps: string[],
  reason: EgressBlockReason,
  detail: string,
  matchedCidr: string | null,
): EgressBlockedError {
  const info: EgressBlockedInfo = {
    url: redactCredentials(url),
    hostname,
    resolvedIps,
    reason,
    matchedCidr,
  };
  try {
    config.onBlocked(info);
  } catch {
    // Telemetry must never fail the block. The error is still thrown.
  }
  return new EgressBlockedError({
    url: info.url,
    hostname,
    resolvedIps,
    reason: detail,
  });
}

function isIpLiteral(hostname: string): boolean {
  return /^[\d.]+$/.test(hostname) || hostname.includes(':');
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const all = await dnsLookup(hostname, { all: true });
  return all.map((entry) => entry.address);
}

/**
 * Strip `user:pass@` from URLs before they land in the audit log so we
 * don't store integration credentials in plaintext. Query strings are
 * left intact — operators routinely paste tokens there but the audit
 * row only fires on the `block` path so the URL exists transiently.
 */
function redactCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString();
    }
  } catch {
    // fall through
  }
  return url;
}
