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
 *   3. Pins the TCP connect address to one of the validated IPs via a
 *      per-request undici dispatcher, so the kernel resolver can't be
 *      tricked into reconnecting to a different (private) address
 *      between our validation lookup and fetch's own — closes the DNS
 *      rebinding window. SNI + Host header still carry the original
 *      hostname so virtual-host routing and certificate validation
 *      keep working.
 *   4. Follows 3xx redirects in-process (up to 5 hops) and re-runs the
 *      resolve-and-validate path on every hop, so a public host can't
 *      redirect to a private one. Callers that need raw hop visibility
 *      can opt into `redirect: 'manual'`.
 *   5. Wraps the response stream so we can refuse to keep reading once
 *      `maxResponseBytes` is exceeded — protects worker memory from a
 *      hostile origin streaming a multi-GB payload.
 *   6. Aborts via AbortSignal after `timeoutMs`.
 *
 * Operators can opt out per-network via `EGRESS_ALLOWED_PRIVATE_CIDRS`
 * (e.g. on-prem RMM endpoints), or globally via
 * `EGRESS_ALLOW_PRIVATE_NETWORKS=true` for lab / single-host setups.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  defaultBlockedCidrs,
  ipMatchesAny,
  parseCidrList,
  type Cidr,
} from './private-cidrs.js';
import { redactUrl } from '../redact-url.js';

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
  /**
   * Per-call additions to the private-CIDR allowlist. Unlike
   * `allowPrivateNetworks`, this keeps the default blocklist for every
   * range NOT in the list (cloud metadata, link-local, multicast, …) and
   * keeps DNS-rebinding pinning active. Prefer this for admin-authorised
   * private endpoints (e.g. `ADMIN_PRIVATE_ENDPOINT_CIDRS` for local
   * LLM servers).
   */
  extraAllowedPrivateCidrs?: readonly Cidr[];
  /** Optional caller-supplied abort signal. */
  signal?: AbortSignal | null;
  /**
   * Hook overrides — only used by tests so the spec can exercise the
   * guard's logic without binding to the real DNS resolver or `fetch`.
   */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  fetchImpl?: typeof fetch;
}

/** Internal: tracks redirect depth across recursive calls. */
interface SafeFetchInternal {
  redirectHopsRemaining?: number;
  visitedUrls?: string[];
}

const MAX_REDIRECT_HOPS = 5;

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

// Default outbound fetch. Deliberately undici's OWN `fetch` — the same
// package that provides `Agent` (our pinned dispatcher). Node's *global*
// `fetch` is served by the undici *bundled inside Node*, whose
// Dispatcher-handler interface can be a different major version than the
// standalone `undici` dependency. Handing a standalone `Agent` to a
// mismatched global fetch throws `UND_ERR_INVALID_ARG: invalid
// onRequestStart method`, which surfaces as an opaque `TypeError: fetch
// failed`. Sourcing fetch and Agent from the same package keeps them
// version-locked regardless of the host Node version. Overridable via
// `setDefaultFetchForTests` (driver specs) or per-call `options.fetchImpl`.
const REAL_FETCH: typeof fetch = undiciFetch as unknown as typeof fetch;
let defaultFetchImpl: typeof fetch = REAL_FETCH;

type ResolveFn = (hostname: string) => Promise<readonly string[]>;

// Default hostname resolver (real DNS). safeFetch resolves BEFORE it
// touches the fetch implementation, so stubbing fetch alone still leaves
// tests dependent on live DNS. Overridable here so specs are hermetic.
let defaultResolveImpl: ResolveFn = defaultResolve;

/**
 * Test-only: swap the default outbound fetch implementation (e.g. a
 * scripted stub in the driver specs). Pass `null` to restore undici's
 * real fetch. Production code never calls this.
 */
export function setDefaultFetchForTests(fn: typeof fetch | null): void {
  defaultFetchImpl = fn ?? REAL_FETCH;
}

/**
 * Test-only companion to `setDefaultFetchForTests`: swap the default DNS
 * resolver so specs don't depend on live name resolution. Pass `null` to
 * restore the real resolver. Production code never calls this.
 */
export function setDefaultResolveForTests(fn: ResolveFn | null): void {
  defaultResolveImpl = fn ?? defaultResolve;
}

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
  defaultFetchImpl = REAL_FETCH;
  defaultResolveImpl = defaultResolve;
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions,
): Promise<Response> {
  return safeFetchInternal(url, options, {});
}

async function safeFetchInternal(
  url: string,
  options: SafeFetchOptions,
  internal: SafeFetchInternal,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? defaultFetchImpl;
  const resolveImpl = options.resolve ?? defaultResolveImpl;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw block(
      url,
      '',
      [],
      'invalid_url',
      `not a valid URL: ${redactUrl(url)}`,
      null,
    );
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

  const allowPrivate = options.allowPrivateNetworks || config.allowAllPrivate;
  if (!allowPrivate) {
    const blockList = defaultBlockedCidrs();
    const extraAllowed = options.extraAllowedPrivateCidrs ?? [];
    for (const ip of resolvedIps) {
      const matched = ipMatchesAny(ip, blockList);
      if (
        matched &&
        !ipMatchesAny(ip, config.allowedPrivateCidrs) &&
        !ipMatchesAny(ip, extraAllowed)
      ) {
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

  // Caller asked us to follow redirects (or didn't say — that's the
  // fetch default). We force the underlying fetch into 'manual' so we
  // can see each 3xx, then re-enter safeFetch on the Location target so
  // the SSRF guard re-validates the hop. A redirect to a private IP
  // raises EgressBlockedError exactly the same way a direct request
  // would.
  const callerRedirect = options.redirect ?? 'follow';
  const followRedirects = callerRedirect === 'follow';

  const controller = new AbortController();
  const external = options.signal ?? null;
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', () => controller.abort(external.reason));
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`safeFetch timeout after ${options.timeoutMs}ms`));
  }, options.timeoutMs);

  // DNS rebinding mitigation: pin the connect address to a validated
  // IP via an undici dispatcher so the kernel resolver can't return a
  // different (private) address than the one we just approved. Skip
  // when the caller supplied a custom `fetchImpl` (tests) or when the
  // URL was already an IP literal (no rebinding window).
  const shouldPin =
    !options.fetchImpl && !isIpLiteral(hostname) && !allowPrivate;
  const pinnedIp = shouldPin ? pickPinnableIp(resolvedIps) : null;
  let ownedAgent: Agent | null = null;
  if (pinnedIp) {
    ownedAgent = new Agent({
      connect: {
        // Force the TCP connect to the IP we validated. SNI +
        // certificate verification still use the original hostname.
        lookup: (_hostname, opts, cb) => {
          const family = pinnedIp.includes(':') ? 6 : 4;
          if (opts.all) {
            cb(null, [{ address: pinnedIp, family }] as never);
          } else {
            (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
              null,
              pinnedIp,
              family,
            );
          }
        },
        servername: hostname,
      },
    });
  } else if (!options.fetchImpl && allowPrivate) {
    // Admin-configured private-network targets (local Ollama/LM Studio,
    // on-prem integrations) are authorised by the caller, but they should
    // not depend on the process-global undici dispatcher. A short-lived
    // per-request agent avoids stale pooled connection state and keeps
    // LAN diagnostics isolated from unrelated outbound traffic.
    ownedAgent = new Agent();
  }

  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
    };
    delete (init as { resolve?: unknown }).resolve;
    delete (init as { fetchImpl?: unknown }).fetchImpl;
    delete (init as { allowPrivateNetworks?: unknown }).allowPrivateNetworks;
    delete (init as { extraAllowedPrivateCidrs?: unknown }).extraAllowedPrivateCidrs;
    delete (init as { maxResponseBytes?: unknown }).maxResponseBytes;
    delete (init as { timeoutMs?: unknown }).timeoutMs;
    // The `dispatcher` knob comes from the bundled undici inside Node's
    // global `fetch`. Node's RequestInit type uses `undici-types` for
    // the slot, but the actual implementation accepts any
    // `Dispatcher`-shaped object. Bypass the structural-match check.
    if (ownedAgent) (init as { dispatcher?: unknown }).dispatcher = ownedAgent;

    const res = await fetchImpl(url, init);

    if (followRedirects && isRedirectStatus(res.status)) {
      const location = res.headers.get('location');
      if (location) {
        const hopsRemaining = internal.redirectHopsRemaining ?? MAX_REDIRECT_HOPS;
        if (hopsRemaining <= 0) {
          // Drain so undici can release the socket back to the pool
          // before we tear down the dispatcher.
          await res.body?.cancel().catch(() => {});
          throw new Error(`safeFetch exceeded ${MAX_REDIRECT_HOPS} redirect hops`);
        }
        const nextUrl = resolveLocation(url, location);
        await res.body?.cancel().catch(() => {});
        clearTimeout(timer);
        await ownedAgent?.close().catch(() => {});
        const visited = internal.visitedUrls ?? [url];
        if (visited.includes(nextUrl)) {
          throw new Error(`safeFetch redirect loop detected at ${nextUrl}`);
        }
        return safeFetchInternal(
          nextUrl,
          { ...options, redirect: 'follow' },
          {
            redirectHopsRemaining: hopsRemaining - 1,
            visitedUrls: [...visited, nextUrl],
          },
        );
      }
    }

    return wrapResponse(
      res,
      options.maxResponseBytes ?? config.defaultMaxResponseBytes,
      timer,
      ownedAgent,
    );
  } catch (err) {
    clearTimeout(timer);
    await ownedAgent?.close().catch(() => {});
    throw err;
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveLocation(base: string, location: string): string {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

function pickPinnableIp(ips: readonly string[]): string | null {
  // Prefer IPv4 for the pinned connect — it's the lowest-friction path
  // through dual-stack networks. If only IPv6 is available, use that.
  const v4 = ips.find((ip) => !ip.includes(':'));
  return v4 ?? ips[0] ?? null;
}

function wrapResponse(
  res: Response,
  maxBytes: number,
  timer: NodeJS.Timeout,
  ownedAgent: Agent | null,
): Response {
  // Clear the timeout once headers are in — body reads handle their own
  // limit. The caller is still responsible for reading promptly.
  clearTimeout(timer);

  const closeAgent = async (): Promise<void> => {
    if (ownedAgent) await ownedAgent.close().catch(() => {});
  };

  if (!res.body) {
    void closeAgent();
    return res;
  }

  const reader = res.body.getReader();
  let received = 0;

  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          await closeAgent();
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
          await closeAgent();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        await closeAgent();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await closeAgent();
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
    url: redactUrl(url),
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
