import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EnvService } from '../config/env.service.js';

/**
 * Phase 11 — AES-256-GCM envelope for `IntegrationSecret.ciphertext`.
 *
 * Architecturally identical to `SecretEncryptionService` (same blob
 * layout, same `kid`-tagged rotation flow), but bound to a separate
 * key (`INTEGRATION_SECRET_KEY`) so password and integration
 * ciphertexts can be rotated independently.
 *
 * Lives in its own service rather than parameterising the existing
 * one to avoid a foot-gun: an integration blob accidentally decrypted
 * with the password vault key would silently look like a tampered
 * blob, which is opaque enough to be confusing in incident response.
 *
 * The plaintext is always a JSON-encoded string — every driver
 * defines its own `secretSchema` and parses the decrypted body.
 */
const ALGO = 'aes-256-gcm';
const FORMAT_VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_KID_LEN = 255;

@Injectable()
export class IntegrationSecretEncryptionService {
  private readonly logger = new Logger(IntegrationSecretEncryptionService.name);
  private readonly activeKey: Buffer;
  private readonly activeKid: string;
  private readonly previousKeys: Map<string, Buffer>;

  constructor(private readonly env: EnvService) {
    this.activeKey = env.integrationActiveKey;
    this.activeKid = env.integrationActiveKid;

    if (this.activeKey.length !== 32) {
      throw new Error('INTEGRATION_SECRET_KEY must decode to exactly 32 bytes');
    }
    if (Buffer.byteLength(this.activeKid, 'utf8') > MAX_KID_LEN) {
      throw new Error(
        `INTEGRATION_SECRET_KEY_KID must be <= ${MAX_KID_LEN} bytes when UTF-8 encoded`,
      );
    }

    this.previousKeys = new Map();
    for (const { kid, key } of env.integrationPreviousKeys) {
      if (key.length !== 32) {
        throw new Error(
          `INTEGRATION_PREVIOUS_KEYS entry "${kid}" must be 32 bytes`,
        );
      }
      if (kid === this.activeKid) {
        throw new Error(
          `INTEGRATION_PREVIOUS_KEYS must not reuse the active kid ("${kid}")`,
        );
      }
      this.previousKeys.set(kid, key);
    }
  }

  /** Encrypt plaintext under the active key. Returns base64. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.activeKey, iv);
    const enc = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const kidBuf = Buffer.from(this.activeKid, 'utf8');
    return Buffer.concat([
      Buffer.from([FORMAT_VERSION]),
      Buffer.from([kidBuf.length]),
      kidBuf,
      iv,
      tag,
      enc,
    ]).toString('base64');
  }

  /** Decrypt base64 blob produced by `encrypt`. Throws on tamper / unknown kid. */
  decrypt(blob: string): string {
    const parsed = parseBlob(blob);
    const key = this.keyFor(parsed.kid);
    const decipher = createDecipheriv(ALGO, key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    const dec = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  }

  /** Re-encrypts under the active kid if the blob was written under an old one. */
  reencryptIfStale(blob: string): { blob: string; rotated: boolean } {
    const parsed = parseBlob(blob);
    if (parsed.kid === this.activeKid) return { blob, rotated: false };
    const key = this.keyFor(parsed.kid);
    const decipher = createDecipheriv(ALGO, key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    const dec = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
    return { blob: this.encrypt(dec.toString('utf8')), rotated: true };
  }

  get currentKid(): string {
    return this.activeKid;
  }

  private keyFor(kid: string): Buffer {
    if (kid === this.activeKid) return this.activeKey;
    const prev = this.previousKeys.get(kid);
    if (!prev) throw new Error(`unknown integration-secret kid "${kid}"`);
    return prev;
  }
}

interface ParsedBlob {
  kid: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function parseBlob(blob: string): ParsedBlob {
  let buf: Buffer;
  try {
    buf = Buffer.from(blob, 'base64');
  } catch {
    throw new Error('integration-secret blob is not valid base64');
  }
  if (buf.length < 2 + 1 + IV_LEN + TAG_LEN) {
    throw new Error('integration-secret blob is truncated');
  }
  const version = buf.readUInt8(0);
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `unsupported integration-secret blob version 0x${version.toString(16)}`,
    );
  }
  const kidLen = buf.readUInt8(1);
  if (kidLen === 0) throw new Error('integration-secret blob has empty kid');
  const kidEnd = 2 + kidLen;
  if (buf.length < kidEnd + IV_LEN + TAG_LEN) {
    throw new Error('integration-secret blob is truncated');
  }
  const kid = buf.subarray(2, kidEnd).toString('utf8');
  const ivEnd = kidEnd + IV_LEN;
  const tagEnd = ivEnd + TAG_LEN;
  return {
    kid,
    iv: buf.subarray(kidEnd, ivEnd),
    tag: buf.subarray(ivEnd, tagEnd),
    ciphertext: buf.subarray(tagEnd),
  };
}
