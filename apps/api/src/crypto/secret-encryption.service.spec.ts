import { createCipheriv, randomBytes } from 'node:crypto';
import { EnvService } from '../config/env.service.js';
import {
  SecretEncryptionService,
  passwordVaultAad,
} from './secret-encryption.service.js';

const AAD = passwordVaultAad('co-1', 'pwd-1', 'password');

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
    const out = svc.encrypt('correct horse battery staple', AAD);
    expect(out).not.toContain('correct horse');
    expect(svc.decrypt(out, AAD)).toBe('correct horse battery staple');
  });

  it('round-trips unicode + long plaintext (notes use-case)', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const plaintext = '🗝️ ' + 'a'.repeat(10_000) + ' — notes ✨';
    const aad = passwordVaultAad('co-1', 'pwd-1', 'notes');
    expect(svc.decrypt(svc.encrypt(plaintext, aad), aad)).toBe(plaintext);
  });

  it('produces different ciphertext each call (unique IV)', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const a = svc.encrypt('same', AAD);
    const b = svc.encrypt('same', AAD);
    expect(a).not.toBe(b);
    expect(svc.decrypt(a, AAD)).toBe('same');
    expect(svc.decrypt(b, AAD)).toBe('same');
  });

  it('binds a blob to its record identity — other rows/tenants/fields fail', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const blob = svc.encrypt('hunter2', AAD);

    expect(() =>
      svc.decrypt(blob, passwordVaultAad('co-1', 'pwd-2', 'password')),
    ).toThrow();
    expect(() =>
      svc.decrypt(blob, passwordVaultAad('co-2', 'pwd-1', 'password')),
    ).toThrow();
    expect(() =>
      svc.decrypt(blob, passwordVaultAad('co-1', 'pwd-1', 'totp')),
    ).toThrow();
    expect(svc.decrypt(blob, AAD)).toBe('hunter2');
  });

  it('rejects a tampered ciphertext', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const good = Buffer.from(svc.encrypt('sensitive', AAD), 'base64');
    good.writeUInt8(good.readUInt8(good.length - 1) ^ 0x01, good.length - 1);
    const bad = good.toString('base64');
    expect(() => svc.decrypt(bad, AAD)).toThrow();
  });

  it('rejects a blob with unknown kid', () => {
    const a = new SecretEncryptionService(makeEnv({ passwordActiveKid: 'k-a' }));
    const blob = a.encrypt('secret', AAD);
    const b = new SecretEncryptionService(makeEnv({ passwordActiveKid: 'k-b' }));
    expect(() => b.decrypt(blob, AAD)).toThrow(/unknown password-vault kid/);
  });

  it('decrypts blobs written under a previous kid via PASSWORD_PREVIOUS_KEYS', () => {
    const oldKey = randomBytes(32);
    const oldSvc = new SecretEncryptionService(
      makeEnv({ passwordActiveKey: oldKey, passwordActiveKid: 'k-old' }),
    );
    const blob = oldSvc.encrypt('rotated secret', AAD);

    const newKey = randomBytes(32);
    const newSvc = new SecretEncryptionService(
      makeEnv({
        passwordActiveKey: newKey,
        passwordActiveKid: 'k-new',
        passwordPreviousKeys: [{ kid: 'k-old', key: oldKey }],
      }),
    );
    expect(newSvc.decrypt(blob, AAD)).toBe('rotated secret');
  });

  it('reencryptIfStale is a no-op for blobs already under the active kid', () => {
    const svc = new SecretEncryptionService(makeEnv());
    const blob = svc.encrypt('static', AAD);
    const out = svc.reencryptIfStale(blob, AAD);
    expect(out.rotated).toBe(false);
    expect(out.blob).toBe(blob);
  });

  it('reencryptIfStale rewrites blobs from an older kid', () => {
    const oldKey = randomBytes(32);
    const oldSvc = new SecretEncryptionService(
      makeEnv({ passwordActiveKey: oldKey, passwordActiveKid: 'k-old' }),
    );
    const oldBlob = oldSvc.encrypt('rotate me', AAD);

    const newKey = randomBytes(32);
    const newSvc = new SecretEncryptionService(
      makeEnv({
        passwordActiveKey: newKey,
        passwordActiveKid: 'k-new',
        passwordPreviousKeys: [{ kid: 'k-old', key: oldKey }],
      }),
    );
    const out = newSvc.reencryptIfStale(oldBlob, AAD);
    expect(out.rotated).toBe(true);
    expect(out.blob).not.toBe(oldBlob);
    expect(newSvc.decrypt(out.blob, AAD)).toBe('rotate me');
    // Re-running is a no-op.
    const again = newSvc.reencryptIfStale(out.blob, AAD);
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
    expect(() => svc.decrypt('', AAD)).toThrow();
    expect(() => svc.decrypt('AAAA', AAD)).toThrow(/truncated/);
  });

  it('decrypts pre-AAD (0x01) password-vault blobs and upgrades them on rewrap', () => {
    const key = Buffer.alloc(32, 7);
    const svc = new SecretEncryptionService(
      makeEnv({ passwordActiveKey: key, passwordActiveKid: 'legacy' }),
    );
    const legacy = legacyBlob('legacy', key, 'legacy password');

    expect(svc.decrypt(legacy, AAD)).toBe('legacy password');

    // Same kid but legacy format → the migration pass rebinds it.
    const upgraded = svc.reencryptIfStale(legacy, AAD);
    expect(upgraded.rotated).toBe(true);
    expect(svc.decrypt(upgraded.blob, AAD)).toBe('legacy password');
    expect(() =>
      svc.decrypt(upgraded.blob, passwordVaultAad('co-1', 'pwd-2', 'password')),
    ).toThrow();
  });
});

function legacyBlob(kid: string, key: Buffer, plaintext: string): string {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const kidBuf = Buffer.from(kid, 'utf8');
  return Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from([kidBuf.length]),
    kidBuf,
    iv,
    tag,
    enc,
  ]).toString('base64');
}
