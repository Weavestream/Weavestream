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
