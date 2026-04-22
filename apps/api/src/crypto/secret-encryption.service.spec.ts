import { randomBytes } from 'node:crypto';
import { EnvService } from '../config/env.service.js';
import { SecretEncryptionService } from './secret-encryption.service.js';

function makeEnv(overrides: Partial<EnvService> = {}): EnvService {
  const activeKey = randomBytes(32);
  const stub: Partial<EnvService> = {
    passwordActiveKey: activeKey,
    passwordActiveKid: 'k-current',
    passwordPreviousKeys: [],
    ...overrides,
  };
  return stub as unknown as EnvService;
}

describe('SecretEncryptionService', () => {
  it('round-trips plaintext', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const out = svc.encrypt('correct horse battery staple');
    expect(out).not.toContain('correct horse');
    expect(svc.decrypt(out)).toBe('correct horse battery staple');
  });

  it('round-trips unicode + long plaintext (notes use-case)', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const plaintext = '🗝️ ' + 'a'.repeat(10_000) + ' — notes ✨';
    expect(svc.decrypt(svc.encrypt(plaintext))).toBe(plaintext);
  });

  it('produces different ciphertext each call (unique IV)', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('same');
    expect(svc.decrypt(b)).toBe('same');
  });

  it('rejects a tampered ciphertext', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const good = Buffer.from(svc.encrypt('sensitive'), 'base64');
    good.writeUInt8(good.readUInt8(good.length - 1) ^ 0x01, good.length - 1);
    const bad = good.toString('base64');
    expect(() => svc.decrypt(bad)).toThrow();
  });

  it('rejects a blob with unknown kid', () => {
    const a = new SecretEncryptionService(makeEnv({ passwordActiveKid: 'k-a' }));
    const blob = a.encrypt('secret');
    const b = new SecretEncryptionService(makeEnv({ passwordActiveKid: 'k-b' }));
    expect(() => b.decrypt(blob)).toThrow(/unknown password-vault kid/);
  });

  it('decrypts blobs written under a previous kid via PASSWORD_PREVIOUS_KEYS', () => {
    const oldKey = randomBytes(32);
    const oldSvc = new SecretEncryptionService(
      makeEnv({ passwordActiveKey: oldKey, passwordActiveKid: 'k-old' }),
    );
    const blob = oldSvc.encrypt('rotated secret');

    const newKey = randomBytes(32);
    const newSvc = new SecretEncryptionService(
      makeEnv({
        passwordActiveKey: newKey,
        passwordActiveKid: 'k-new',
        passwordPreviousKeys: [{ kid: 'k-old', key: oldKey }],
      }),
    );
    expect(newSvc.decrypt(blob)).toBe('rotated secret');
  });

  it('reencryptIfStale is a no-op for blobs already under the active kid', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const blob = svc.encrypt('static');
    const out = svc.reencryptIfStale(blob);
    expect(out.rotated).toBe(false);
    expect(out.blob).toBe(blob);
  });

  it('reencryptIfStale rewrites blobs from an older kid', () => {
    const oldKey = randomBytes(32);
    const oldSvc = new SecretEncryptionService(
      makeEnv({ passwordActiveKey: oldKey, passwordActiveKid: 'k-old' }),
    );
    const oldBlob = oldSvc.encrypt('rotate me');

    const newKey = randomBytes(32);
    const newSvc = new SecretEncryptionService(
      makeEnv({
        passwordActiveKey: newKey,
        passwordActiveKid: 'k-new',
        passwordPreviousKeys: [{ kid: 'k-old', key: oldKey }],
      }),
    );
    const out = newSvc.reencryptIfStale(oldBlob);
    expect(out.rotated).toBe(true);
    expect(out.blob).not.toBe(oldBlob);
    expect(newSvc.decrypt(out.blob)).toBe('rotate me');
    // Re-running is a no-op.
    const again = newSvc.reencryptIfStale(out.blob);
    expect(again.rotated).toBe(false);
  });

  it('rejects an active kid that reappears in PASSWORD_PREVIOUS_KEYS', () => {
    const key = randomBytes(32);
    expect(
      () =>
        new SecretEncryptionService(
          makeEnv({
            passwordActiveKey: key,
            passwordActiveKid: 'k-same',
            passwordPreviousKeys: [{ kid: 'k-same', key: randomBytes(32) }],
          }),
        ),
    ).toThrow(/must not reuse the active kid/);
  });

  it('rejects a wrong-length active key', () => {
    expect(
      () =>
        new SecretEncryptionService(
          makeEnv({ passwordActiveKey: randomBytes(16) }),
        ),
    ).toThrow(/32 bytes/);
  });

  it('rejects malformed / truncated blobs', () => {
    const svc = new SecretEncryptionService(makeEnv());
    expect(() => svc.decrypt('')).toThrow();
    expect(() => svc.decrypt('AAAA')).toThrow(/truncated/);
  });
});
