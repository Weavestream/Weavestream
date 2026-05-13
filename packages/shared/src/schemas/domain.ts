import { z } from 'zod';

/**
 * Phase 8 — Domain & SSL monitor schemas.
 *
 * The hostname schema is the trust boundary for everything downstream:
 * the WHOIS / RDAP / DNS / TLS checks all feed the normalised value
 * into network APIs, so we reject anything that isn't a plain DNS
 * label sequence. Rejecting leading/trailing dots, IP literals, and
 * `user@host` / `host:port` forms up front means the engine never has
 * to guess.
 *
 * Normalisation rules:
 *   - trim + lowercase the whole string (DNS is case-insensitive)
 *   - reject anything starting with `http://` / `https://` — callers
 *     should strip the scheme before handing us the value
 *   - reject whitespace anywhere
 *   - reject any segment longer than 63 chars or starting/ending with
 *     a hyphen (RFC 1035)
 *   - accept punycode labels (`xn--…`) verbatim; let the client do the
 *     IDNA conversion before submitting
 */

const MAX_HOSTNAME_LEN = 253;
const MAX_LABEL_LEN = 63;
const LABEL_RE = /^(?!-)[a-z0-9\-]+(?<!-)$/;

export const domainHostnameSchema = z
  .string()
  .min(1)
  .max(MAX_HOSTNAME_LEN)
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => v.length > 0, { message: 'hostname is required' })
  .refine((v) => !v.includes(' '), { message: 'hostname must not contain spaces' })
  .refine((v) => !v.includes('/') && !v.includes(':') && !v.includes('@'), {
    message: 'hostname must not contain URL metadata (scheme/port/userinfo)',
  })
  .refine((v) => !v.startsWith('.') && !v.endsWith('.'), {
    message: 'hostname must not start or end with a dot',
  })
  .refine(
    (v) => {
      // Reject IPv4 literals.
      if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return false;
      // Reject IPv6 literals (rough check — they'd have `:` anyway).
      if (v.includes('[') || v.includes(']')) return false;
      return true;
    },
    { message: 'hostname must be a DNS name, not an IP literal' },
  )
  .refine(
    (v) => {
      const labels = v.split('.');
      if (labels.length < 2) return false;
      for (const label of labels) {
        if (label.length === 0 || label.length > MAX_LABEL_LEN) return false;
        if (!LABEL_RE.test(label)) return false;
      }
      return true;
    },
    { message: 'hostname must be a valid DNS name (e.g. example.com)' },
  );

/**
 * Accepted by both create + update. `alertThresholdDays` defaults to 30
 * server-side so callers can omit it.
 */
/**
 * DKIM selector override.
 *
 * Persisted as a comma-separated string on `MonitoredDomain` so the DB
 * column type stays simple. The schema validates each selector against
 * the DNS-label grammar from RFC 6376 §3.1 — a paste error can't
 * smuggle an arbitrary FQDN into the `<selector>._domainkey.<host>`
 * query the engine builds. Empty / whitespace input round-trips to
 * `null` upstream of the schema (handled in the service layer).
 *
 * Callers use `parseDkimSelectorOverride()` to expand the stored
 * string into an array when invoking the engine.
 */
const DKIM_SELECTOR_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAX_DKIM_SELECTORS = 12;

export const dkimSelectorOverrideSchema = z
  .string()
  .max(512)
  .refine(
    (v) => {
      const trimmed = v.trim();
      if (trimmed.length === 0) return true;
      const parts = trimmed
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > MAX_DKIM_SELECTORS) return false;
      return parts.every((s) => DKIM_SELECTOR_LABEL.test(s));
    },
    {
      message: `at most ${MAX_DKIM_SELECTORS} comma-separated DNS labels (a-z, 0-9, hyphen)`,
    },
  )
  // Accept `null` from the client as "clear the override". The DB
  // column is nullable; the form posts `null` when the field is empty.
  .nullable();

export function parseDkimSelectorOverride(
  raw: string | null | undefined,
): string[] {
  if (!raw) return [];
  const out = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(out)).slice(0, MAX_DKIM_SELECTORS);
}

export const createMonitoredDomainSchema = z.object({
  hostname: domainHostnameSchema,
  checkWhois: z.boolean().optional(),
  checkDns: z.boolean().optional(),
  checkTls: z.boolean().optional(),
  alertThresholdDays: z.number().int().min(1).max(365).optional(),
  visibleToClients: z.boolean().optional(),
  dkimSelectorOverride: dkimSelectorOverrideSchema.optional(),
});

export const updateMonitoredDomainSchema = z
  .object({
    hostname: domainHostnameSchema.optional(),
    checkWhois: z.boolean().optional(),
    checkDns: z.boolean().optional(),
    checkTls: z.boolean().optional(),
    alertThresholdDays: z.number().int().min(1).max(365).optional(),
    visibleToClients: z.boolean().optional(),
    dkimSelectorOverride: dkimSelectorOverrideSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type CreateMonitoredDomainInput = z.infer<typeof createMonitoredDomainSchema>;
export type UpdateMonitoredDomainInput = z.infer<typeof updateMonitoredDomainSchema>;

// ---------------------------------------------------------------------
// Response shapes — rendered by services, consumed by web + CLI.
// ---------------------------------------------------------------------

export const checkResultSchema = z.enum(['OK', 'WARN', 'FAIL', 'SKIP']);
export type CheckResultValue = z.infer<typeof checkResultSchema>;

export const domainStatusSchema = z.enum([
  'OK',
  'EXPIRING',
  'EXPIRED',
  'FAIL',
  'UNKNOWN',
]);
export type DomainStatusValue = z.infer<typeof domainStatusSchema>;

// ---------------------------------------------------------------------
// Domain check details — v2 schema.
//
// Versioning rule: rows written prior to the v2 rollout have no
// `schemaVersion` field (treated as v1). All v2 fields are optional so
// the parser still accepts v1 payloads — the UI surfaces "ungraded"
// for any row that lacks `score`.
//
// Every new sub-object is optional so partial-result writes (a check
// that times out mid-fan-out) round-trip without violating the schema.
// ---------------------------------------------------------------------

const tierEnum = z.enum(['excellent', 'good', 'fair', 'poor', 'critical']);
export const domainScoreTierSchema = tierEnum;
export type DomainScoreTier = z.infer<typeof tierEnum>;

const scoreBreakdownItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  points: z.number(),
  max: z.number(),
  status: z.enum(['pass', 'partial', 'fail', 'skip']),
  evidence: z.string().optional(),
});

const domainScoreSchema = z.object({
  version: z.number().int(),
  total: z.number(),
  max: z.number(),
  percent: z.number().int().min(0).max(100),
  tier: tierEnum,
  breakdown: z.array(scoreBreakdownItemSchema),
  hardOverride: z
    .object({
      kind: z.enum(['force_critical', 'cap_fair']),
      reason: z.string(),
    })
    .nullable()
    .optional(),
});

export type DomainScore = z.infer<typeof domainScoreSchema>;
export type DomainScoreBreakdownItem = z.infer<typeof scoreBreakdownItemSchema>;

export const domainCheckDetailsSchema = z.object({
  schemaVersion: z.number().int().min(1).optional(),
  whois: z
    .object({
      registrar: z.string().nullable().optional(),
      registeredAt: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
      source: z.enum(['rdap', 'whois43', 'none']),
      /**
       * v2 — Parsed EPP status codes from the WHOIS/RDAP response.
       * `locked` is true when the codes contain any of the
       * `clientTransferProhibited` / `serverTransferProhibited` /
       * `clientDeleteProhibited` / `serverDeleteProhibited` / etc.
       * flags that prevent unauthorised transfer or deletion.
       *
       * `hold` is true for any `clientHold` / `serverHold` — those
       * codes mean the domain is suspended at the registry and is a
       * hard FAIL override regardless of the apparent expiry date.
       */
      statusCodes: z.array(z.string()).optional(),
      locked: z.boolean().optional(),
      hold: z.boolean().optional(),
      /**
       * Nameservers as reported by the WHOIS/RDAP response. Lower-cased
       * with trailing dots stripped so the engine's `nsMatch` helper
       * can set-compare against the DNS NS answer.
       */
      whoisNs: z.array(z.string()).optional(),
    })
    .optional(),
  dns: z
    .object({
      a: z.array(z.string()).optional(),
      aaaa: z.array(z.string()).optional(),
      mx: z
        .array(z.object({ preference: z.number(), exchange: z.string() }))
        .optional(),
      ns: z.array(z.string()).optional(),
      /** v2 — full TXT record set at the apex (one entry per record). */
      txt: z.array(z.string()).optional(),
      /** v2 — CAA records at the apex. */
      caa: z
        .array(
          z.object({
            flag: z.number().int(),
            tag: z.string(),
            value: z.string(),
          }),
        )
        .optional(),
      /**
       * v2 — DNSSEC signing verdict. `source` documents which signal
       * we used (RDAP `secureDNS.delegationSigned` is authoritative,
       * DNSKEY probe is best-effort fallback, `none` means we couldn't
       * determine either way).
       */
      dnssec: z
        .object({
          signed: z.boolean(),
          source: z.enum(['rdap', 'dnskey', 'none']),
          dsRecordCount: z.number().int().optional(),
        })
        .optional(),
      /** v2 — DNS NS vs WHOIS NS reconciliation. */
      nsMatch: z
        .object({
          dnsNs: z.array(z.string()),
          whoisNs: z.array(z.string()),
          match: z.enum(['match', 'mismatch', 'unverifiable']),
        })
        .optional(),
    })
    .optional(),
  /**
   * v2 — Email authentication sub-checks. Skipped (omitted entirely)
   * when the domain has no MX records — the scoring rubric drops the
   * whole email block from the denominator instead of penalising the
   * domain for not handling mail.
   */
  email: z
    .object({
      /** True when the domain has at least one MX record (drives auto-skip). */
      hasMx: z.boolean(),
      spf: z
        .object({
          present: z.boolean(),
          record: z.string().nullable().optional(),
          mechanisms: z.array(z.string()).optional(),
          all: z.enum(['+all', '-all', '~all', '?all']).nullable().optional(),
          lookupCount: z.number().int().optional(),
          valid: z.boolean(),
        })
        .optional(),
      dmarc: z
        .object({
          present: z.boolean(),
          policy: z.enum(['none', 'quarantine', 'reject']).nullable().optional(),
          subdomainPolicy: z
            .enum(['none', 'quarantine', 'reject'])
            .nullable()
            .optional(),
          pct: z.number().int().nullable().optional(),
          rua: z.array(z.string()).optional(),
          ruf: z.array(z.string()).optional(),
          raw: z.string().nullable().optional(),
        })
        .optional(),
      dkim: z
        .object({
          selectorsChecked: z.array(z.string()),
          selectorsFound: z.array(z.string()),
          provider: z
            .enum(['google', 'microsoft', 'mailgun', 'sendgrid', 'unknown'])
            .optional(),
        })
        .optional(),
    })
    .optional(),
  tls: z
    .object({
      validFrom: z.string().nullable().optional(),
      validTo: z.string().nullable().optional(),
      issuer: z.string().nullable().optional(),
      subjectAltNames: z.array(z.string()).optional(),
      chainLength: z.number().optional(),
      protocol: z.string().nullable().optional(),
      /**
       * Result of Node's built-in trust validation (system CA store +
       * hostname). The probe runs with `rejectUnauthorized: false` so
       * it can inspect untrusted certs; this field surfaces the
       * verdict so the UI/alerting can still flag them.
       */
      authorized: z.boolean().nullable().optional(),
      authorizationError: z.string().nullable().optional(),
      /**
       * v2 — Cert crypto + lifetime metadata. `daysUntilExpiry` is
       * negative when the cert is already expired; the rubric uses it
       * for partial-credit tiers (>14, 1-30, expired).
       */
      cert: z
        .object({
          keyAlgo: z.string().nullable().optional(),
          keyBits: z.number().int().nullable().optional(),
          sigAlgo: z.string().nullable().optional(),
          mustStaple: z.boolean().optional(),
          ocspStapled: z.boolean().optional(),
          daysUntilExpiry: z.number().nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * v2 — HTTPS reachability + security headers. Folded into the engine
   * (separate from the alerts-feature `runHttpCheck`) so the scoring
   * pass can read the same evidence the persisted row stores.
   */
  http: z
    .object({
      redirectsToHttps: z.boolean(),
      finalStatus: z.number().int().nullable().optional(),
      finalUrl: z.string().nullable().optional(),
      hsts: z
        .object({
          present: z.boolean(),
          maxAge: z.number().int().nullable().optional(),
          includeSubDomains: z.boolean().optional(),
          preload: z.boolean().optional(),
        })
        .optional(),
      error: z.string().nullable().optional(),
    })
    .optional(),
  /** v2 — overall hygiene score (percentage 0-100 with breakdown). */
  score: domainScoreSchema.optional(),
});

export type DomainCheckDetails = z.infer<typeof domainCheckDetailsSchema>;

export const monitoredDomainSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  hostname: z.string(),
  checkWhois: z.boolean(),
  checkDns: z.boolean(),
  checkTls: z.boolean(),
  alertThresholdDays: z.number().int(),
  visibleToClients: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  whoisExpiresAt: z.string().nullable(),
  tlsExpiresAt: z.string().nullable(),
  latestStatus: domainStatusSchema,
  /**
   * v2 — Latest hygiene score (percentage 0-100). NULL when the domain
   * has never been checked under the v2 rubric. Denormalised onto
   * `monitored_domains` so list views don't have to join history.
   */
  latestScore: z.number().int().min(0).max(100).nullable(),
  /** v2 — comma-separated DKIM selectors to probe in addition to defaults. */
  dkimSelectorOverride: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MonitoredDomainDto = z.infer<typeof monitoredDomainSchema>;

export const domainCheckSchema = z.object({
  id: z.string().uuid(),
  monitoredDomainId: z.string().uuid(),
  companyId: z.string().uuid(),
  checkedAt: z.string(),
  whoisStatus: checkResultSchema.nullable(),
  dnsStatus: checkResultSchema.nullable(),
  tlsStatus: checkResultSchema.nullable(),
  whoisExpiresAt: z.string().nullable(),
  tlsExpiresAt: z.string().nullable(),
  details: domainCheckDetailsSchema,
  error: z.string().nullable(),
  /** v2 — denormalised percent score (0-100). NULL for legacy rows. */
  score: z.number().int().min(0).max(100).nullable(),
  /** v2 — rubric schema version (1 = legacy, 2+ = scored). */
  schemaVersion: z.number().int().nullable(),
});

export type DomainCheckDto = z.infer<typeof domainCheckSchema>;

export const domainAlertSchema = z.object({
  companyId: z.string().uuid(),
  companyName: z.string(),
  companySlug: z.string(),
  domainId: z.string().uuid(),
  hostname: z.string(),
  status: domainStatusSchema,
  daysUntilExpiry: z.number().nullable(),
  visibleToClients: z.boolean(),
});

export type DomainAlertDto = z.infer<typeof domainAlertSchema>;
