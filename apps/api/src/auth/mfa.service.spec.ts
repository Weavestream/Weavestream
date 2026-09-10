import { MfaService } from './mfa.service.js';
import { EnvService } from '../config/env.service.js';

function makeEnv(): EnvService {
  const env = Object.create(EnvService.prototype) as EnvService;
  (env as unknown as { values: unknown }).values = {
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  return env;
}

describe('MfaService encryption', () => {
  const svc = new MfaService(makeEnv());

  it('round-trips a secret via AES-256-GCM', () => {
    const secret = svc.generateSecret();
    const blob = svc.encryptSecret(secret);
    expect(blob).not.toContain(secret);
    expect(svc.decryptSecret(blob)).toBe(secret);
  });

  it('each encryption uses a fresh IV (outputs differ)', () => {
    const secret = svc.generateSecret();
    const a = svc.encryptSecret(secret);
    const b = svc.encryptSecret(secret);
    expect(a).not.toBe(b);
  });
});

describe('MfaService.qrMatrix', () => {
  const svc = new MfaService(makeEnv());
  const url = svc.otpauthUrl('a@b.c', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');

  // The whole point of this method: no `data:` URL reaches the browser,
  // because the desktop CSP grants `img-src 'self'` and nothing else.
  it('returns an SVG path, not a data URL', () => {
    const { path } = svc.qrMatrix(url);
    expect(path).not.toContain('data:');
    expect(path.startsWith('M')).toBe(true);
    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  it('reports a size that includes the quiet-zone margin on both sides', () => {
    const { size } = svc.qrMatrix(url);
    // Every QR version is (4 * version + 17) modules square, so an odd
    // module count plus a 1-module margin each side stays odd.
    expect(size % 2).toBe(1);
    expect(size).toBeGreaterThanOrEqual(21 + 2);
  });

  it('keeps every run inside the viewBox', () => {
    const { size, path } = svc.qrMatrix(url);
    const runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)];
    expect(runs.length).toBeGreaterThan(0);
    for (const [, x, y, run] of runs) {
      expect(Number(x)).toBeGreaterThanOrEqual(1);
      expect(Number(y)).toBeGreaterThanOrEqual(1);
      expect(Number(x) + Number(run)).toBeLessThanOrEqual(size - 1);
    }
  });

  it('is deterministic for one otpauth URL', () => {
    expect(svc.qrMatrix(url)).toEqual(svc.qrMatrix(url));
  });

  it('encodes different secrets differently', () => {
    const other = svc.otpauthUrl('a@b.c', 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU');
    expect(svc.qrMatrix(url).path).not.toBe(svc.qrMatrix(other).path);
  });
});
