import { loadEnv, topologyWarnings, type Env } from '@weavestream/shared/server';

// A complete, schema-valid env we can clone and tweak per case. Mirrors the
// fixture in `env.service.spec.ts`; kept local so each spec stays standalone.
function baseEnv(): NodeJS.ProcessEnv {
  const key = Buffer.alloc(32, 2).toString('base64');
  return {
    NODE_ENV: 'production',
    APP_URL: 'https://portal.example.com',
    API_URL: 'https://portal.example.com/api',
    DATABASE_URL: 'postgresql://u:p@postgres:5432/db',
    REDIS_URL: 'redis://redis:6379/0',
    JWT_SIGNING_KEY: key,
    JWT_SIGNING_KEY_KID: 'k-1',
    MFA_ENCRYPTION_KEY: key,
    COOKIE_SIGNING_KEY: key,
    CSRF_SIGNING_KEY: key,
    FILE_STORAGE_DIR: '/tmp/weavestream-test-files',
    PASSWORD_ENCRYPTION_KEY: key,
    PASSWORD_ENCRYPTION_KEY_KID: 'pk-1',
    INTEGRATION_SECRET_KEY: key,
    INTEGRATION_SECRET_KEY_KID: 'ik-1',
    SMTP_SECRET_KEY: key,
    SMTP_SECRET_KEY_KID: 'smtp-1',
  };
}

function envWith(overrides: NodeJS.ProcessEnv): Env {
  return loadEnv({ ...baseEnv(), ...overrides });
}

const NODE_ENV_WARNING = /NODE_ENV is "(development|test)"/;
const HTTP_WARNING = /APP_URL is plain HTTP/;

describe('topologyWarnings — NODE_ENV vs public HTTPS (WS-008)', () => {
  it('stays quiet on the default localhost dev config', () => {
    expect(
      topologyWarnings(
        envWith({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000' }),
      ),
    ).toEqual([]);
  });

  it('warns on a public HTTPS host running with NODE_ENV=development', () => {
    const warnings = topologyWarnings(envWith({ NODE_ENV: 'development' }));
    expect(warnings.some((w) => NODE_ENV_WARNING.test(w))).toBe(true);
    // It is the NODE_ENV warning, not the plain-HTTP one.
    expect(warnings.some((w) => HTTP_WARNING.test(w))).toBe(false);
  });

  it('warns on a public HTTPS host running with NODE_ENV=test', () => {
    expect(
      topologyWarnings(envWith({ NODE_ENV: 'test' })).some((w) =>
        NODE_ENV_WARNING.test(w),
      ),
    ).toBe(true);
  });

  it('is silent when a public HTTPS host runs with NODE_ENV=production', () => {
    expect(
      topologyWarnings(envWith({ NODE_ENV: 'production' })).some((w) =>
        NODE_ENV_WARNING.test(w),
      ),
    ).toBe(false);
  });

  it('does not add the NODE_ENV warning for a non-production LOCAL host', () => {
    // looksPublicHost gates everything: localhost never warns regardless of env.
    expect(
      topologyWarnings(
        envWith({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000' }),
      ).some((w) => NODE_ENV_WARNING.test(w)),
    ).toBe(false);
  });

  it('a public HTTP host triggers the HTTP warning, not the HTTPS/NODE_ENV one', () => {
    const warnings = topologyWarnings(
      envWith({ NODE_ENV: 'development', APP_URL: 'http://portal.example.com' }),
    );
    expect(warnings.some((w) => HTTP_WARNING.test(w))).toBe(true);
    expect(warnings.some((w) => NODE_ENV_WARNING.test(w))).toBe(false);
  });
});
