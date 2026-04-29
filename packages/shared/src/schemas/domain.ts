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
export const createMonitoredDomainSchema = z.object({
  hostname: domainHostnameSchema,
  checkWhois: z.boolean().optional(),
  checkDns: z.boolean().optional(),
  checkTls: z.boolean().optional(),
  alertThresholdDays: z.number().int().min(1).max(365).optional(),
  visibleToClients: z.boolean().optional(),
});

export const updateMonitoredDomainSchema = z
  .object({
    hostname: domainHostnameSchema.optional(),
    checkWhois: z.boolean().optional(),
    checkDns: z.boolean().optional(),
    checkTls: z.boolean().optional(),
    alertThresholdDays: z.number().int().min(1).max(365).optional(),
    visibleToClients: z.boolean().optional(),
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

export const domainCheckDetailsSchema = z.object({
  whois: z
    .object({
      registrar: z.string().nullable().optional(),
      registeredAt: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
      source: z.enum(['rdap', 'whois43', 'none']),
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
    })
    .optional(),
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
