import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// Marker brand on `base64Key` schemas so `loadEnv` can recognise which
// missing/invalid fields are 32-byte encryption keys and offer freshly
// generated replacements in its error output.
const BASE64_KEY_BRAND = '__base64Key' as const;

const base64Key = (minBytes: number) => {
  const schema = z
    .string()
    .min(1)
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length >= minBytes;
        } catch {
          return false;
        }
      },
      { message: `must be base64-encoded and decode to at least ${minBytes} bytes` },
    );
  (schema as unknown as { [BASE64_KEY_BRAND]: number })[BASE64_KEY_BRAND] = minBytes;
  return schema;
};

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v)));

const intFromString = (min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? v : parseInt(v, 10)))
    .pipe(z.number().int().min(min).max(max));

// Browser-active content types are rejected from ALLOWED_UPLOAD_MIME at
// boot, no matter what the operator configures. Today allowing them would
// not yield stored XSS on its own (SVG fails the magic-byte gate, and
// non-`image/*` types are force-downloaded with `nosniff`), but that
// safety must not depend on the serving logic never changing — an entry
// here would turn a future inline-serving tweak into an immediate
// stored-XSS primitive. The `image/*+xml` pattern catches SVG aliases and
// any other XML-based image type a browser might parse as a document.
const FORBIDDEN_UPLOAD_MIMES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);

export const isForbiddenUploadMime = (mime: string): boolean => {
  const m = mime.trim().toLowerCase();
  return FORBIDDEN_UPLOAD_MIMES.has(m) || (m.startsWith('image/') && m.endsWith('+xml'));
};

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url(),
  API_URL: z.string().url(),

  DATABASE_URL: z.string().url(),
  POSTGRES_USER: z.string().min(1).optional(),
  POSTGRES_PASSWORD: z.string().min(1).optional(),
  POSTGRES_DB: z.string().min(1).optional(),

  REDIS_URL: z.string().url(),
  REDIS_PASSWORD: z.string().min(1).optional(),

  JWT_SIGNING_KEY: base64Key(32),
  // Key-id label stamped on each signed/encrypted record so keys can be
  // rotated later (the active key, plus historical keys in *_PREVIOUS_KEYS,
  // are looked up by this tag). The value is opaque — a fresh install just
  // needs *a* stable label, so it defaults to '1' and is not surfaced in
  // .env.example. On rotation, bump it (to '2', a date, etc.) and move the
  // old key into the matching *_PREVIOUS_KEYS. The default must stay a fixed
  // constant across releases: existing data is tagged with it, so changing
  // it would orphan those records unless the old kid is in *_PREVIOUS_KEYS.
  JWT_SIGNING_KEY_KID: z.string().min(1).default('1'),
  JWT_PREVIOUS_KEYS: z.string().optional().default(''),
  SESSION_COOKIE_NAME: z.string().min(1).default('ws_session'),
  SESSION_MAX_AGE_DAYS: intFromString(1, 365).default(30),
  ACCESS_TOKEN_TTL_MIN: intFromString(1, 60).default(15),
  MFA_ENCRYPTION_KEY: base64Key(32),
  COOKIE_SIGNING_KEY: base64Key(32),
  CSRF_SIGNING_KEY: base64Key(32),

  // Phase 10: password vault encryption. AES-256-GCM key material for
  // encrypting `passwords.password_ciphertext`, `notes_ciphertext`, and
  // `totp_secret_ciphertext`. Supports rotation via the same
  // `kid`-tagged scheme used by JWT: new key becomes
  // PASSWORD_ENCRYPTION_KEY / _KID, the old pair is moved to
  // PASSWORD_PREVIOUS_KEYS (comma-separated `kid:base64key`). Records
  // written under an old kid decrypt seamlessly and are re-encrypted
  // under the current kid on next update, or eagerly via
  // `cli reencrypt-passwords`.
  PASSWORD_ENCRYPTION_KEY: base64Key(32),
  PASSWORD_ENCRYPTION_KEY_KID: z.string().min(1).max(32).default('1'),
  PASSWORD_PREVIOUS_KEYS: z.string().optional().default(''),
  HIBP_ENABLED: boolish.default(true),

  // Phase 11: integration secret encryption. Same `kid`-tagged scheme
  // as the password vault — `INTEGRATION_SECRET_KEY` decrypts the
  // active ciphertext, `INTEGRATION_PREVIOUS_KEYS` (comma-separated
  // `kid:base64key`) keeps older blobs readable until they are
  // re-encrypted on the next mutation. The key MUST be distinct from
  // PASSWORD_ENCRYPTION_KEY so password and integration ciphertexts
  // can be rotated independently.
  INTEGRATION_SECRET_KEY: base64Key(32),
  INTEGRATION_SECRET_KEY_KID: z.string().min(1).max(32).default('1'),
  INTEGRATION_PREVIOUS_KEYS: z.string().optional().default(''),

  // Global SMTP credential encryption. Kept separate from password vault
  // and integration keys so mail credentials can be rotated independently.
  SMTP_SECRET_KEY: base64Key(32),
  SMTP_SECRET_KEY_KID: z.string().min(1).max(32).default('1'),
  SMTP_PREVIOUS_KEYS: z.string().optional().default(''),

  // Phase 11: integration sync scheduling + concurrency.
  //
  // `INTEGRATION_SYNC_DEFAULT_CRON` is registered as the BullMQ
  // repeat pattern when an Integration row sets `syncCron = null` and
  // status = ACTIVE. Set to the literal string "off" to disable the
  // global scheduler — manual runs from the admin UI still work.
  INTEGRATION_SYNC_DEFAULT_CRON: z.string().min(1).default('*/15 * * * *'),
  INTEGRATION_SYNC_ORCHESTRATOR_CONCURRENCY: intFromString(1, 50).default(2),
  INTEGRATION_SYNC_MAPPING_CONCURRENCY: intFromString(1, 100).default(5),
  INTEGRATION_HTTP_TIMEOUT_MS: intFromString(1_000, 120_000).default(30_000),
  INTEGRATION_HTTP_MAX_RETRIES: intFromString(0, 10).default(5),
  INTEGRATION_HTTP_BACKOFF_MS: intFromString(100, 60_000).default(1_000),

  ARGON2_MEMORY_KB: intFromString(16384, 1048576).default(65536),
  ARGON2_ITERATIONS: intFromString(1, 20).default(3),
  ARGON2_PARALLELISM: intFromString(1, 16).default(4),

  GLOBAL_RATE_LIMIT_PER_MIN: intFromString(1, 10000).default(600),
  AUTH_RATE_LIMIT_PER_MIN: intFromString(1, 1000).default(5),
  LOCKOUT_MAX_FAILURES: intFromString(1, 100).default(5),
  LOCKOUT_WINDOW_MIN: intFromString(1, 1440).default(15),

  // WS-030 — AI chat read-tool budgets. Fixed-window Redis counters
  // capping how many read-tool executions the streaming loop may run
  // per user and per conversation each hour, independent of the
  // per-request HTTP throttle (each chat request can trigger several
  // internal tool/model operations). Exhaustion degrades gracefully:
  // the model is told to answer with what it has; chat keeps working.
  AI_TOOL_BUDGET_USER_PER_HOUR: intFromString(1, 10000).default(100),
  AI_TOOL_BUDGET_CONVERSATION_PER_HOUR: intFromString(1, 10000).default(40),

  // Step-up (re-authentication) validity window. After an admin
  // re-confirms a credential (MFA code or password) on a sensitive
  // action, the proof is cached in Redis keyed by session id for this
  // many seconds before another confirmation is required. Kept short so
  // a stolen/idle session can't keep exfiltrating after one prompt;
  // default 15 min balances that against re-prompting on every action.
  STEP_UP_TTL_SEC: intFromString(60, 3600).default(900),

  // How many trusted reverse-proxy hops sit between the internet and
  // the `web` (Next.js) container — i.e. the edge tier the operator
  // runs (Caddy, Nginx, Traefik, Cloudflare, …). The web tier reads
  // this knob to resolve the real client IP from inbound
  // `X-Forwarded-For` before forwarding a single, sanitized entry to
  // the API. Topology guide (count proxies **in front of `web`**):
  //   0 → web is directly internet-facing (no edge — IP attribution
  //       degrades to a sentinel since Next.js doesn't expose the
  //       socket peer in App Router server contexts).
  //   1 → edge proxy → web → api       (default; one operator-managed
  //       reverse proxy in front of compose).
  //   2 → CDN → edge → web → api       (e.g. Cloudflare in front of a
  //       Caddy/Traefik edge).
  // Setting this too high lets a malicious upstream forge the client
  // IP; setting it too low collapses every request behind your edge
  // into a single throttler bucket. The API itself no longer reads
  // this — it trusts only requests arriving from the private docker
  // bridge (loopback / link-local / unique-local), where the only
  // client is the web container. See `apps/api/src/main.ts`.
  TRUST_PROXY_HOPS: intFromString(0, 10).default(1),

  // Phase 6 — egress / SSRF guard.
  //
  // Every server-side outbound HTTP request flows through `safeFetch`,
  // which resolves the hostname and refuses to connect when a target
  // resolves to a loopback / RFC1918 / link-local / multicast / reserved
  // IP. That blocks the standard SSRF playbook (operator paste of
  // `http://127.0.0.1`, `http://169.254.169.254` for cloud metadata,
  // `http://10.x.x.x` to peek at internal services).
  //
  // `EGRESS_ALLOW_PRIVATE_NETWORKS=true` disables the entire blocklist.
  // Use only in lab / single-host setups where the API is talking to
  // sibling containers over a flat private network and there are no
  // operator-supplied URLs.
  //
  // `EGRESS_ALLOWED_PRIVATE_CIDRS` is the surgical alternative — a
  // comma-separated list of CIDRs that are permitted even when the
  // global blocklist is on. Use this for on-prem RMM endpoints
  // (`10.42.0.0/16,192.168.50.0/24`).
  EGRESS_ALLOW_PRIVATE_NETWORKS: boolish.default(false),
  EGRESS_ALLOWED_PRIVATE_CIDRS: z.string().optional().default(''),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Local filesystem storage. Every uploaded file (attachments,
  // thumbnails, company logos, export PDFs) lives under this root,
  // tenant-isolated by directory:
  //   ${FILE_STORAGE_DIR}/<companyId>/uploads/<uploadId>/<filename>
  //   ${FILE_STORAGE_DIR}/<companyId>/thumbs/<uploadId>.webp
  //   ${FILE_STORAGE_DIR}/<companyId>/exports/<exportId>.pdf
  //
  // Default is `./data/files` so a fresh checkout / bare host install
  // lands files alongside `./data/postgres` and `./data/redis`. Inside
  // the api/worker containers, compose.yml sets this to the absolute
  // bind-mount target (`/var/lib/weavestream/files`) which is fed by
  // `${DATA_DIR}/files` on the host — same effective location, just
  // with the container/host paths spelled out explicitly.
  FILE_STORAGE_DIR: z.string().min(1).default('./data/files'),
  MAX_UPLOAD_MB: intFromString(1, 1024).default(25),

  // Local filesystem destination for scheduled Postgres dumps and the
  // sidecar `*.manifest.json` files written by the worker. Mirrors the
  // FILE_STORAGE_DIR pattern: defaults to `./data/backup` for bare-host
  // / dev checkouts; compose.yml overrides it inside the api/worker
  // containers to `/var/lib/weavestream/backup` (host-bind-mounted from
  // `${DATA_DIR}/backup`). The api mounts this read-only (downloads
  // only); the worker mounts it read-write (dump + prune).
  BACKUP_STORAGE_DIR: z.string().min(1).default('./data/backup'),

  // Maximum minutes a single backup job is allowed to run before the
  // BullMQ lock expires and the job is treated as stalled. Sized for
  // worst-case `pg_dump --format=custom` runtime on slow disks or
  // NAS-backed Docker hosts. The default of 360 (6 hours) covers
  // everything from the typical sub-GB Weavestream Postgres up to
  // tens-of-GB audit-heavy installs on consumer NAS hardware. Operators
  // with unusually large databases can raise this further; smaller /
  // SSD-backed installs can lower it for quicker stall detection.
  BACKUP_JOB_LOCK_MINUTES: intFromString(5, 24 * 60).default(360),

  // Phase 7 — soft-deleted Upload reaper. Same `'off'` semantics as
  // `DOMAIN_CHECK_CRON`. Retention floor is 1 day so a misconfigured
  // env can't reap freshly-deleted uploads. Batch size caps how many
  // rows a single tick will process, keeping the advisory-lock hold
  // window bounded on installs with backlog churn.
  UPLOAD_REAPER_CRON: z.string().min(1).default('7 4 * * *'),
  UPLOAD_REAPER_RETENTION_DAYS: intFromString(1, 365).default(30),
  UPLOAD_REAPER_BATCH_SIZE: intFromString(1, 5000).default(500),
  // WS-013 — orphaned pending-upload bytes. A relay PUT that is never
  // confirmed leaves its bytes on disk after the 15-minute Redis
  // session lapses; the reaper removes those directories once they are
  // older than this. Floor of 1 hour keeps a misconfigured env from
  // sweeping uploads that are still in flight.
  UPLOAD_ORPHAN_MIN_AGE_HOURS: intFromString(1, 24 * 30).default(24),

  // Phase 8: Domain & SSL monitor + BullMQ infra.
  //
  // `DOMAIN_CHECK_CRON` follows the BullMQ `repeat.pattern` syntax
  // (standard 5-field cron). Set to the literal string "off" to skip
  // the repeatable-job registration — useful for local dev, tests,
  // and migration windows. Manual on-demand checks remain enabled.
  DOMAIN_CHECK_CRON: z.string().min(1).default('17 3 * * *'),
  DOMAIN_CHECK_CONCURRENCY: intFromString(1, 100).default(5),
  DOMAIN_CHECK_TIMEOUT_MS: intFromString(1000, 60_000).default(10_000),
  DOMAIN_CHECK_ATTEMPTS: intFromString(1, 10).default(3),
  DOMAIN_CHECK_BACKOFF_MS: intFromString(1_000, 600_000).default(30_000),
  RDAP_BOOTSTRAP_CACHE_HOURS: intFromString(1, 720).default(24),

  WORKER_CONCURRENCY_GLOBAL: intFromString(1, 500).default(10),

  // Alerts feature. Repeatable job that evaluates time/state-based
  // alert configs (SINGLE_EXPIRATION, EXPIRATION_LIST, WEBSITE_DOWN).
  // Real-time RECORD_EVENT / PASSWORD_EVENT alerts do NOT depend on
  // this cron — they fire from `AuditLogService.log()` synchronously.
  // Set to the literal string "off" to disable scheduled scans (manual
  // test sends still work).
  ALERTS_SCAN_CRON: z.string().min(1).default('*/5 * * * *'),
  // Per-domain HTTP probe timeout used by the `WEBSITE_DOWN` evaluator
  // and the domain-checks processor. Distinct from the WHOIS/DNS/TLS
  // timeout because HTTP can be much faster on healthy hosts but slow
  // on dead ones (kept generous so we don't false-positive on a
  // bogged-down origin).
  HTTP_CHECK_TIMEOUT_MS: intFromString(1_000, 60_000).default(8_000),

  ALLOWED_UPLOAD_MIME: z
    .string()
    .min(1)
    .default(
      [
        'image/jpeg',
        // Legacy alias some clients still declare; the confirm step's
        // compat table pairs it with detected `image/jpeg`.
        'image/jpg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/heic',
        'image/heif',
        'application/pdf',
        // Plain-text family. Markdown is RFC 7763 `text/markdown`; we
        // also accept `text/x-markdown` which some older clients still
        // emit. CSV rounds out common structured-text uploads.
        'text/plain',
        'text/markdown',
        'text/x-markdown',
        'text/csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        // Archives — detected by `file-type` via magic bytes.
        'application/zip',
        'application/x-zip-compressed',
        'application/x-7z-compressed',
        'application/x-tar',
        'application/gzip',
        // Microsoft installer + Outlook message. Both are Compound File
        // Binary (CFB) under the hood, detected as `application/x-cfb`;
        // the confirm-step allows the declared/detected pair explicitly.
        'application/x-msi',
        'application/x-ms-installer',
        'application/vnd.ms-outlook',
        // RFC 822 email messages (.eml). Plain text with no magic bytes —
        // the confirm step treats `message/rfc822` like text/* for the
        // no-signature fallback (see `isTextLikeDeclared`).
        'message/rfc822',
        // Script + config families. These have no magic bytes — the
        // server's `isTextDeclared` fallback keeps `text/*` uploads
        // legal without a signature.
        'text/x-shellscript',
        'text/x-python',
        'application/json',
        'application/xml',
        'text/xml',
        'text/yaml',
        'application/x-yaml',
      ].join(','),
    )
    .superRefine((v, ctx) => {
      const rejected = [
        ...new Set(
          v
            .split(',')
            .map((m) => m.trim().toLowerCase())
            .filter(Boolean)
            .filter(isForbiddenUploadMime),
        ),
      ];
      if (rejected.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `must not include browser-active content types (got: ${rejected.join(', ')}). ` +
            'text/html, application/xhtml+xml, and image/*+xml (e.g. image/svg+xml) can execute ' +
            'script when rendered inline and are rejected regardless of configuration.',
        });
      }
    }),
});

export type Env = z.infer<typeof envSchema>;

// Build a lookup of which schema fields are `base64Key(N)` so the boot
// error can suggest a freshly generated value for each one. Resolved
// once at module load — `envSchema.shape` is stable.
const BASE64_KEY_FIELDS: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (const [name, def] of Object.entries(envSchema.shape)) {
    const bytes = (def as unknown as { [BASE64_KEY_BRAND]?: number })[BASE64_KEY_BRAND];
    if (typeof bytes === 'number') map[name] = bytes;
  }
  return map;
})();

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatEnvError(result.error.issues));
  }
  return result.data;
}

function formatEnvError(issues: readonly z.ZodIssue[]): string {
  const missingKeys: string[] = [];
  const invalidKeys: string[] = [];
  const otherIssues: string[] = [];

  for (const issue of issues) {
    const name = issue.path.join('.');
    if (name in BASE64_KEY_FIELDS) {
      // `Required` (Zod's `invalid_type` on undefined) → field is absent
      // entirely. Anything else (length / base64 refinement) → field is
      // present but malformed.
      if (issue.code === 'invalid_type') missingKeys.push(name);
      else invalidKeys.push(`  - ${name}: ${issue.message}`);
      continue;
    }
    otherIssues.push(`  - ${name || '(root)'}: ${issue.message}`);
  }

  const lines: string[] = ['Invalid env:'];
  if (otherIssues.length) lines.push(...otherIssues);
  if (invalidKeys.length) lines.push(...invalidKeys);

  if (missingKeys.length) {
    lines.push(
      '',
      `Missing required encryption key${missingKeys.length === 1 ? '' : 's'}.`,
      'Append the following line(s) to your .env and restart:',
      '',
    );
    const today = new Date().toISOString().slice(0, 7); // YYYY-MM
    const knownFields = new Set(Object.keys(envSchema.shape));
    for (const name of missingKeys) {
      const bytes = BASE64_KEY_FIELDS[name] ?? 32;
      lines.push(`  ${name}=${randomBytes(bytes).toString('base64')}`);
      // When a key field has a `_KID` sibling in the schema and that
      // sibling is also absent, suggest a paired kid so the operator
      // copies a complete, working block rather than half a config.
      const kidName = `${name}_KID`;
      if (
        knownFields.has(kidName) &&
        issues.some((i) => i.path[0] === kidName && i.code === 'invalid_type')
      ) {
        lines.push(`  ${kidName}=${today}`);
      }
    }
    lines.push(
      '',
      'These values were freshly generated for this restart — losing them',
      'after data has been written under them is unrecoverable, so save',
      'them to .env now rather than letting the container regenerate.',
      '',
      'You can also re-run scripts/keygen.sh (or scripts/keygen.ps1) and',
      'append only the lines you need.',
    );
  }

  return lines.join('\n');
}

export function parsePreviousKeys(
  v: string,
  label = 'PREVIOUS_KEYS',
): Array<{ kid: string; key: Buffer }> {
  if (!v) return [];
  return v
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [kid, key] = pair.split(':');
      if (!kid || !key) {
        throw new Error(`${label} entry must be "kid:base64key", got "${pair}"`);
      }
      return { kid, key: Buffer.from(key, 'base64') };
    });
}

// ── Deployment topology sanity warnings ──────────────────────────────────
//
// Best-effort, log-only heads-up emitted at boot (see `apps/api/src/main.ts`).
// These never throw and never change behavior — they only surface the env
// "smells" of an unsafe direct-public deployment so an operator who never
// opened the docs still gets told in the container logs.
//
// Detection is deliberately conservative (zero false positives on the
// default `http://localhost:3000`): if `APP_URL` is HTTPS, something in
// front of `web` already terminates TLS — the container itself serves only
// plain HTTP on its port — so a trusted edge necessarily exists and
// `TRUST_PROXY_HOPS >= 1` is the correct, non-warned shape. The
// env-detectable unsafe shapes are a public **HTTP** `APP_URL` (no TLS
// terminator → `web` is almost certainly exposed directly), `TRUST_PROXY_HOPS=0`
// on a public host (IP attribution disabled), and a public **HTTPS** `APP_URL`
// running with `NODE_ENV !== 'production'` (WS-008 — dev/test mode relaxes the
// web CSP to permit `unsafe-eval` and skips production hardening/optimizations).

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127) return true; // unspecified / loopback
  if (a === 10) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Best-effort check for whether a URL host looks reachable from the public
 * internet. Returns `false` for loopback, `*.local` / `*.lan` /
 * `*.internal` / `*.home.arpa`, RFC1918, IPv4 link-local, and IPv6
 * loopback / link-local / unique-local hosts — the same private families
 * Express's `trust proxy` setting uses in `apps/api/src/main.ts`. Used only
 * to scope the topology warnings below; it is NOT a security boundary.
 */
export function looksPublicHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '::' || h === '0.0.0.0') return false;
  if (/\.(local|localhost|internal|lan)$|\.home\.arpa$/.test(h)) return false;
  if (isPrivateIpv4(h)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return false; // IPv6 link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return false; // IPv6 unique-local fc00::/7
  return true;
}

/**
 * Returns log-only warnings about an unsafe public deployment topology.
 * Pure and side-effect free — the caller decides whether and where to log.
 * Never throws. An empty array means nothing looks wrong (or `APP_URL`
 * points at a local/LAN host, where direct exposure is expected).
 */
export function topologyWarnings(env: Env): string[] {
  const warnings: string[] = [];

  let host: string;
  let protocol: string;
  try {
    const url = new URL(env.APP_URL);
    host = url.hostname;
    protocol = url.protocol;
  } catch {
    // APP_URL is already URL-validated by the schema; be defensive anyway.
    return warnings;
  }

  if (!looksPublicHost(host)) return warnings;

  if (protocol === 'http:') {
    warnings.push(
      'APP_URL is plain HTTP on a public host (' +
        host +
        '). Weavestream does not terminate TLS — put a trusted reverse proxy ' +
        '(Caddy, Nginx, Traefik, …) in front of the `web` container for HTTPS. ' +
        'Exposing the web port directly to the internet is intended for ' +
        'local/LAN use only. See docs/deployment/tls.',
    );
  }

  if (protocol === 'https:' && env.NODE_ENV !== 'production') {
    warnings.push(
      'APP_URL is HTTPS on a public host (' +
        host +
        ') but NODE_ENV is "' +
        env.NODE_ENV +
        '", not "production". A public deployment should run with ' +
        'NODE_ENV=production: development/test mode relaxes the web ' +
        "Content-Security-Policy (permits 'unsafe-eval'), emits verbose error " +
        'output, and skips production optimizations. Set NODE_ENV=production. ' +
        'See docs/deployment/tls.',
    );
  }

  if (env.TRUST_PROXY_HOPS === 0) {
    warnings.push(
      'TRUST_PROXY_HOPS=0 on a public host: per-IP login lockout, rate ' +
        'limiting, IP allow/deny rules, and audit attribution are disabled — ' +
        'every request is recorded as the 0.0.0.0 sentinel. This is only safe ' +
        'when `web` is directly internet-facing with no proxy. Behind a trusted ' +
        'reverse proxy, set TRUST_PROXY_HOPS to the number of hops in front of ' +
        '`web` (default 1). See docs/deployment/tls.',
    );
  }

  return warnings;
}

// Re-export the boolish helper for downstream apps that parse additional env vars.
export { boolish };
