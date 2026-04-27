import { createCipheriv, randomBytes } from 'node:crypto';
import { EnvService } from '../config/env.service.js';
import { IntegrationSecretEncryptionService } from './integration-secret-encryption.service.js';

/**
 * Phase 11 — round-trip + rotation tests for the integration-secret
 * envelope. Mirrors `secret-encryption.service.spec.ts` because the
 * two services share a blob layout but bind different keys.
 */
function makeEnv(overrides: Partial<EnvService> = {}): EnvService {
  const stub: Partial<EnvService> = {
    integrationActiveKey: randomBytes(32),
    integrationActiveKid: 'i-current',
    integrationPreviousKeys: [],
    ...overrides,
  };
  return stub as unknown as EnvService;
}

describe('IntegrationSecretEncryptionService', () => {
  it('round-trips plaintext and never leaks it in the ciphertext', () => {
    const svc = new IntegrationSecretEncryptionService(makeEnv());
    const out = svc.encrypt('refresh_token=abc123');
    expect(out).not.toContain('abc123');
    expect(svc.decrypt(out)).toBe('refresh_token=abc123');
  });

  it('round-trips JSON payloads (driver secret bundle shape)', () => {
    const svc = new IntegrationSecretEncryptionService(makeEnv());
    const payload = JSON.stringify({
      apiKey: 'k-' + 'x'.repeat(64),
      apiSecret: 's-' + 'y'.repeat(64),
    });
    expect(svc.decrypt(svc.encrypt(payload))).toBe(payload);
  });

  it('produces unique ciphertext per call (random IV)', () => {
    const svc = new IntegrationSecretEncryptionService(makeEnv());
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('same');
    expect(svc.decrypt(b)).toBe('same');
  });

  it('rejects tampered ciphertext', () => {
    const svc = new IntegrationSecretEncryptionService(makeEnv());
    const good = Buffer.from(svc.encrypt('sensitive'), 'base64');
    good.writeUInt8(good.readUInt8(good.length - 1) ^ 0x01, good.length - 1);
    const bad = good.toString('base64');
    expect(() => svc.decrypt(bad)).toThrow();
  });

  it('rejects a blob with unknown kid', () => {
    const a = new IntegrationSecretEncryptionService(
      makeEnv({ integrationActiveKid: 'i-a' }),
    );
    const blob = a.encrypt('secret');
    const b = new IntegrationSecretEncryptionService(
      makeEnv({ integrationActiveKid: 'i-b' }),
    );
    expect(() => b.decrypt(blob)).toThrow(/unknown integration-secret kid/);
  });

  it('decrypts blobs written under a previous kid via INTEGRATION_PREVIOUS_KEYS', () => {
    const oldKey = randomBytes(32);
    const oldSvc = new IntegrationSecretEncryptionService(
      makeEnv({ integrationActiveKey: oldKey, integrationActiveKid: 'i-old' }),
    );
    const blob = oldSvc.encrypt('rotated secret');

    const newSvc = new IntegrationSecretEncryptionService(
      makeEnv({
        integrationActiveKey: randomBytes(32),
        integrationActiveKid: 'i-new',
        integrationPreviousKeys: [{ kid: 'i-old', key: oldKey }],
      }),
    );
    expect(newSvc.decrypt(blob)).toBe('rotated secret');
  });

  it('reencryptIfStale rewrites blobs from an older kid', () => {
    const oldKey = randomBytes(32);
    const oldSvc = new IntegrationSecretEncryptionService(
      makeEnv({ integrationActiveKey: oldKey, integrationActiveKid: 'i-old' }),
    );
    const oldBlob = oldSvc.encrypt('rotate me');

    const newSvc = new IntegrationSecretEncryptionService(
      makeEnv({
        integrationActiveKey: randomBytes(32),
        integrationActiveKid: 'i-new',
        integrationPreviousKeys: [{ kid: 'i-old', key: oldKey }],
      }),
    );
    const out = newSvc.reencryptIfStale(oldBlob);
    expect(out.rotated).toBe(true);
    expect(newSvc.decrypt(out.blob)).toBe('rotate me');
    expect(newSvc.reencryptIfStale(out.blob).rotated).toBe(false);
  });

  it('rejects an active kid that reappears in INTEGRATION_PREVIOUS_KEYS', () => {
    const key = randomBytes(32);
    expect(
      () =>
        new IntegrationSecretEncryptionService(
          makeEnv({
            integrationActiveKey: key,
            integrationActiveKid: 'i-same',
            integrationPreviousKeys: [{ kid: 'i-same', key: randomBytes(32) }],
          }),
        ),
    ).toThrow(/must not reuse the active kid/);
  });

  it('rejects a wrong-length active key', () => {
    expect(
      () =>
        new IntegrationSecretEncryptionService(
          makeEnv({ integrationActiveKey: randomBytes(16) }),
        ),
    ).toThrow(/32 bytes/);
  });

  it('decrypts pre-refactor integration-secret blobs', () => {
    const key = Buffer.alloc(32, 9);
    const svc = new IntegrationSecretEncryptionService(
      makeEnv({ integrationActiveKey: key, integrationActiveKid: 'legacy' }),
    );

    expect(svc.decrypt(legacyBlob('legacy', key, 'legacy integration'))).toBe(
      'legacy integration',
    );
  });
});

function legacyBlob(kid: string, key: Buffer, plaintext: string): string {
  const iv = Buffer.alloc(12, 4);
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
