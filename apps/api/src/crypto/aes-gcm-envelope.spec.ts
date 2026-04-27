import { randomBytes } from 'node:crypto';
import { AesGcmEnvelope } from './aes-gcm-envelope.js';

describe('AesGcmEnvelope', () => {
  it('round-trips plaintext without leaking it', () => {
    const envelope = makeEnvelope();
    const blob = envelope.encrypt('smtp-password');

    expect(blob).not.toContain('smtp-password');
    expect(envelope.decrypt(blob)).toBe('smtp-password');
  });

  it('produces unique ciphertext per call', () => {
    const envelope = makeEnvelope();
    const a = envelope.encrypt('same');
    const b = envelope.encrypt('same');

    expect(a).not.toBe(b);
    expect(envelope.decrypt(a)).toBe('same');
    expect(envelope.decrypt(b)).toBe('same');
  });

  it('decrypts and rotates blobs from a previous kid', () => {
    const oldKey = randomBytes(32);
    const old = makeEnvelope({ activeKey: oldKey, activeKid: 'old' });
    const blob = old.encrypt('rotate me');
    const current = makeEnvelope({
      activeKid: 'new',
      previousKeys: [{ kid: 'old', key: oldKey }],
    });

    expect(current.decrypt(blob)).toBe('rotate me');
    const rotated = current.reencryptIfStale(blob);
    expect(rotated.rotated).toBe(true);
    expect(current.decrypt(rotated.blob)).toBe('rotate me');
    expect(current.reencryptIfStale(rotated.blob).rotated).toBe(false);
  });

  it('rejects tampered and unknown-kid blobs', () => {
    const envelope = makeEnvelope();
    const good = Buffer.from(envelope.encrypt('secret'), 'base64');
    good.writeUInt8(good.readUInt8(good.length - 1) ^ 0x01, good.length - 1);
    expect(() => envelope.decrypt(good.toString('base64'))).toThrow();

    const other = makeEnvelope({ activeKid: 'other' });
    expect(() => other.decrypt(envelope.encrypt('secret'))).toThrow(
      /unknown test-secret kid/,
    );
  });

  it('validates key material', () => {
    expect(() => makeEnvelope({ activeKey: randomBytes(16) })).toThrow(/32 bytes/);
    const key = randomBytes(32);
    expect(() =>
      makeEnvelope({
        activeKey: key,
        activeKid: 'same',
        previousKeys: [{ kid: 'same', key: randomBytes(32) }],
      }),
    ).toThrow(/must not reuse the active kid/);
  });
});

function makeEnvelope(
  overrides: Partial<{
    activeKey: Buffer;
    activeKid: string;
    previousKeys: Array<{ kid: string; key: Buffer }>;
  }> = {},
) {
  return new AesGcmEnvelope({
    activeKey: overrides.activeKey ?? randomBytes(32),
    activeKid: overrides.activeKid ?? 'current',
    previousKeys: overrides.previousKeys ?? [],
    keyLabel: 'TEST_SECRET_KEY',
    previousKeysLabel: 'TEST_PREVIOUS_KEYS',
    blobLabel: 'test-secret',
  });
}
