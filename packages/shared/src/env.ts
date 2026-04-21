import { z } from 'zod';

const base64Key = (minBytes: number) =>
  z
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

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v)));

const intFromString = (min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? v : parseInt(v, 10)))
    .pipe(z.number().int().min(min).max(max));

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
  JWT_SIGNING_KEY_KID: z.string().min(1),
  JWT_PREVIOUS_KEYS: z.string().optional().default(''),
  SESSION_COOKIE_NAME: z.string().min(1).default('ws_session'),
  SESSION_MAX_AGE_DAYS: intFromString(1, 365).default(30),
  ACCESS_TOKEN_TTL_MIN: intFromString(1, 60).default(15),
  MFA_ENCRYPTION_KEY: base64Key(32),
  COOKIE_SIGNING_KEY: base64Key(32),
  CSRF_SIGNING_KEY: base64Key(32),

  ARGON2_MEMORY_KB: intFromString(16384, 1048576).default(65536),
  ARGON2_ITERATIONS: intFromString(1, 20).default(3),
  ARGON2_PARALLELISM: intFromString(1, 16).default(4),

  GLOBAL_RATE_LIMIT_PER_MIN: intFromString(1, 10000).default(100),
  AUTH_RATE_LIMIT_PER_MIN: intFromString(1, 1000).default(5),
  LOCKOUT_MAX_FAILURES: intFromString(1, 100).default(5),
  LOCKOUT_WINDOW_MIN: intFromString(1, 1440).default(15),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Phase 4: MinIO object storage + upload policy.
  // Buckets are created lazily per-company as `${MINIO_BUCKET_PREFIX}-<companyId>`.
  // `MINIO_PUBLIC_URL` is what the browser sees for presigned PUT/GET —
  // when the stack runs under compose, the API resolves `MINIO_ENDPOINT`
  // (e.g. `minio`) internally but browsers hit `MINIO_PUBLIC_URL`
  // (typically `http://localhost:9100`).
  MINIO_ENDPOINT: z.string().min(1).default('minio'),
  MINIO_PORT: intFromString(1, 65535).default(9000),
  MINIO_USE_SSL: boolish.default(false),
  MINIO_REGION: z.string().min(1).default('us-east-1'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET_PREFIX: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase DNS-safe prefix')
    .default('weavestream'),
  MINIO_PUBLIC_URL: z.string().url(),
  MAX_UPLOAD_MB: intFromString(1, 1024).default(25),

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

  ALLOWED_UPLOAD_MIME: z
    .string()
    .min(1)
    .default(
      [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/heic',
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
    ),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid env:\n${issues}`);
  }
  return result.data;
}

export function parsePreviousKeys(v: string): Array<{ kid: string; key: Buffer }> {
  if (!v) return [];
  return v
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [kid, key] = pair.split(':');
      if (!kid || !key) {
        throw new Error(`JWT_PREVIOUS_KEYS entry must be "kid:base64key", got "${pair}"`);
      }
      return { kid, key: Buffer.from(key, 'base64') };
    });
}

// Re-export the boolish helper for downstream apps that parse additional env vars.
export { boolish };
