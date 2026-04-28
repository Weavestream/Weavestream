import { loadEnv } from '@weavestream/shared/server';

function validEnv(): NodeJS.ProcessEnv {
  const key = Buffer.alloc(32, 2).toString('base64');
  return {
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:3000/api',
    DATABASE_URL: 'postgresql://u:p@postgres:5432/db',
    REDIS_URL: 'redis://redis:6379/0',
    JWT_SIGNING_KEY: key,
    JWT_SIGNING_KEY_KID: 'k-1',
    MFA_ENCRYPTION_KEY: key,
    COOKIE_SIGNING_KEY: key,
    CSRF_SIGNING_KEY: key,
    MINIO_ACCESS_KEY: 'test-access',
    MINIO_SECRET_KEY: 'test-secret',
    MINIO_PUBLIC_URL: 'http://localhost:9100',
    PASSWORD_ENCRYPTION_KEY: key,
    PASSWORD_ENCRYPTION_KEY_KID: 'pk-1',
    INTEGRATION_SECRET_KEY: key,
    INTEGRATION_SECRET_KEY_KID: 'ik-1',
    SMTP_SECRET_KEY: key,
    SMTP_SECRET_KEY_KID: 'smtp-1',
  };
}

describe('env validation', () => {
  it('accepts a valid env', () => {
    const env = loadEnv(validEnv());
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('throws on missing JWT_SIGNING_KEY', () => {
    const env = validEnv();
    delete env.JWT_SIGNING_KEY;
    expect(() => loadEnv(env)).toThrow(/JWT_SIGNING_KEY/);
  });

  it('throws when a key is not 32 decoded bytes', () => {
    const env = validEnv();
    env.JWT_SIGNING_KEY = Buffer.alloc(8, 1).toString('base64');
    expect(() => loadEnv(env)).toThrow(/at least 32 bytes/);
  });

  it('rejects unknown enum values', () => {
    const env = validEnv();
    env.NODE_ENV = 'staging';
    expect(() => loadEnv(env)).toThrow(/NODE_ENV/);
  });

  it('emits paste-ready replacement lines for missing encryption keys', () => {
    const env = validEnv();
    delete env.SMTP_SECRET_KEY;
    delete env.SMTP_SECRET_KEY_KID;
    let message = '';
    try {
      loadEnv(env);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Missing required encryption key/);
    expect(message).toMatch(/SMTP_SECRET_KEY=[A-Za-z0-9+/=]{40,}/);
    expect(message).toMatch(/SMTP_SECRET_KEY_KID=\d{4}-\d{2}/);
  });
});
