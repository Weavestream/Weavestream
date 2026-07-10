import { createCipheriv, randomBytes } from 'node:crypto';
import { AesGcmEnvelope } from './aes-gcm-envelope.js';

const AAD = 'test:tenant-1:record-1:field';

describe('AesGcmEnvelope', () => {
  it('round-trips plaintext without leaking it', () => {
    const envelope = makeEnvelope();
    const blob = envelope.encrypt('smtp-password', AAD);

    expect(blob).not.toContain('smtp-password');
    expect(envelope.decrypt(blob, AAD)).toBe('smtp-password');
  });

  it('produces unique ciphertext per call', () => {
    const envelope = makeEnvelope();
    const a = envelope.encrypt('same', AAD);
    const b = envelope.encrypt('same', AAD);

    expect(a).not.toBe(b);
    expect(envelope.decrypt(a, AAD)).toBe('same');
    expect(envelope.decrypt(b, AAD)).toBe('same');
  });

  it('rejects decryption under a different record identity (AAD mismatch)', () => {
    const envelope = makeEnvelope();
    const blob = envelope.encrypt('hidden credential', AAD);

    // Same tenant, different row — the relocation attack the AAD blocks.
    expect(() =>
      envelope.decrypt(blob, 'test:tenant-1:record-2:field'),
    ).toThrow();
    // Same row, different field.
    expect(() =>
      envelope.decrypt(blob, 'test:tenant-1:record-1:other-field'),
    ).toThrow();
    // Different tenant.
    expect(() =>
      envelope.decrypt(blob, 'test:tenant-2:record-1:field'),
    ).toThrow();
    // The true identity still works.
    expect(envelope.decrypt(blob, AAD)).toBe('hidden credential');
  });

  it('rejects an empty AAD on encrypt', () => {
    const envelope = makeEnvelope();
    expect(() => envelope.encrypt('secret', '')).toThrow(/AAD must be non-empty/);
  });

  it('decrypts legacy 0x01 blobs (pre-AAD) regardless of the AAD passed', () => {
    const key = randomBytes(32);
    const envelope = makeEnvelope({ activeKey: key, activeKid: 'current' });
    const legacy = legacyBlob('current', key, 'legacy secret');

    expect(envelope.decrypt(legacy, AAD)).toBe('legacy secret');
    expect(envelope.decrypt(legacy, 'a-completely-different-identity')).toBe(
      'legacy secret',
    );
  });

  it('reencryptIfStale upgrades legacy 0x01 blobs to the AAD-bound format', () => {
    const key = randomBytes(32);
    const envelope = makeEnvelope({ activeKey: key, activeKid: 'current' });
    const legacy = legacyBlob('current', key, 'bind me');

    // Same kid, but legacy format → still rewrapped.
    const upgraded = envelope.reencryptIfStale(legacy, AAD);
    expect(upgraded.rotated).toBe(true);
    expect(envelope.decrypt(upgraded.blob, AAD)).toBe('bind me');
    // The upgraded blob is now identity-bound.
    expect(() => envelope.decrypt(upgraded.blob, 'other-identity')).toThrow();
    // Re-running is a no-op.
    expect(envelope.reencryptIfStale(upgraded.blob, AAD).rotated).toBe(false);
  });

  it('decrypts and rotates blobs from a previous kid', () => {
    const oldKey = randomBytes(32);
    const old = makeEnvelope({ activeKey: oldKey, activeKid: 'old' });
    const blob = old.encrypt('rotate me', AAD);
    const current = makeEnvelope({
      activeKid: 'new',
      previousKeys: [{ kid: 'old', key: oldKey }],
    });

    expect(current.decrypt(blob, AAD)).toBe('rotate me');
    const rotated = current.reencryptIfStale(blob, AAD);
    expect(rotated.rotated).toBe(true);
    expect(current.decrypt(rotated.blob, AAD)).toBe('rotate me');
    expect(current.reencryptIfStale(rotated.blob, AAD).rotated).toBe(false);
  });

  it('rejects tampered and unknown-kid blobs', () => {
    const envelope = makeEnvelope();
    const good = Buffer.from(envelope.encrypt('secret', AAD), 'base64');
    good.writeUInt8(good.readUInt8(good.length - 1) ^ 0x01, good.length - 1);
    expect(() => envelope.decrypt(good.toString('base64'), AAD)).toThrow();

    const other = makeEnvelope({ activeKid: 'other' });
    expect(() => other.decrypt(envelope.encrypt('secret', AAD), AAD)).toThrow(
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

/** Builds a pre-AAD 0x01 blob the way the envelope wrote them before v2. */
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
