import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EnvService } from '../config/env.service.js';

const ALGO = 'aes-256-gcm';
const FORMAT_VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_KID_LEN = 255;

/**
 * AES-256-GCM envelope used for every password-vault secret (password,
 * TOTP secret, notes). Designed to allow seamless key rotation via a
 * `kid`-tagged blob + `PASSWORD_PREVIOUS_KEYS` — identical spirit to the
 * JWT signing-key rotation flow.
 *
 * Blob layout (then base64-encoded for storage):
 *
 *   +--------+---------+--------+------+--------+----------------+
 *   | ver(1) | kidLen  |  kid   |  iv  |  tag   |   ciphertext   |
 *   |  0x01  |   1B    |  N B   | 12B  |  16B   |      ...       |
 *   +--------+---------+--------+------+--------+----------------+
 *
 * `kid` is the key id under which the blob was encrypted. On decrypt we
 * look up the matching key material:
 *   1. If kid === active kid → decrypt with the active key.
 *   2. Else scan PASSWORD_PREVIOUS_KEYS for a matching kid.
 *   3. Else throw.
 *
 * `reencryptIfStale` is called on every write path: if a blob's kid is
 * not the active kid, it is re-encrypted under the active key. This
 * gives lazy rotation without touching rows that are never updated — a
 * one-shot CLI (`cli reencrypt-passwords`) walks the full tables for
 * operators who want immediate rotation.
 *
 * All methods take and return opaque strings; plaintext bytes live in
 * memory for as short as possible and are never logged.
 */
@Injectable()
export class SecretEncryptionService {
  private readonly logger = new Logger(SecretEncryptionService.name);
  private readonly activeKey: Buffer;
  private readonly activeKid: string;
  private readonly previousKeys: Map<string, Buffer>;

  constructor(private readonly env: EnvService) {
    this.activeKey = env.passwordActiveKey;
    this.activeKid = env.passwordActiveKid;

    if (this.activeKey.length !== 32) {
      throw new Error('PASSWORD_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
    if (Buffer.byteLength(this.activeKid, 'utf8') > MAX_KID_LEN) {
      throw new Error(
        `PASSWORD_ENCRYPTION_KEY_KID must be <= ${MAX_KID_LEN} bytes when UTF-8 encoded`,
      );
    }

    this.previousKeys = new Map();
    for (const { kid, key } of env.passwordPreviousKeys) {
      if (key.length !== 32) {
        throw new Error(`PASSWORD_PREVIOUS_KEYS entry "${kid}" must be 32 bytes`);
      }
      if (kid === this.activeKid) {
        throw new Error(
          `PASSWORD_PREVIOUS_KEYS must not reuse the active kid ("${kid}")`,
        );
      }
      this.previousKeys.set(kid, key);
    }
  }

  /**
   * Encrypt plaintext under the currently active key. Returns an opaque
   * base64 string suitable for direct storage in a TEXT column.
   */
  encrypt(plaintext: string): string {
    return this.encryptWith(plaintext, this.activeKey, this.activeKid);
  }

  /**
   * Decrypt an opaque blob produced by `encrypt` (or a previous kid's
   * equivalent). Throws if the kid is unknown, the ciphertext is
   * tampered, or the format is invalid.
   */
  decrypt(blob: string): string {
    const parsed = parseBlob(blob);
    const key = this.keyFor(parsed.kid);
    const decipher = createDecipheriv(ALGO, key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    const dec = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    return dec.toString('utf8');
  }

  /**
   * If `blob` was encrypted under a non-active kid, re-encrypt under the
   * current active key and return the new blob. Otherwise return the
   * blob unchanged. Used on write paths (update) to lazily migrate
   * records after a key rotation.
   *
   * Returns `{ blob, rotated }` — callers that care to count rotations
   * (the CLI) inspect `rotated`.
   */
  reencryptIfStale(blob: string): { blob: string; rotated: boolean } {
    const parsed = parseBlob(blob);
    if (parsed.kid === this.activeKid) {
      return { blob, rotated: false };
    }
    const key = this.keyFor(parsed.kid);
    const decipher = createDecipheriv(ALGO, key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    const dec = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    return {
      blob: this.encryptWith(dec.toString('utf8'), this.activeKey, this.activeKid),
      rotated: true,
    };
  }

  /**
   * The kid currently issued for new writes. Exposed for CLI progress
   * reporting only; callers MUST NOT make authorization or routing
   * decisions off this value.
   */
  get currentKid(): string {
    return this.activeKid;
  }

  private encryptWith(plaintext: string, key: Buffer, kid: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const kidBuf = Buffer.from(kid, 'utf8');
    return Buffer.concat([
      Buffer.from([FORMAT_VERSION]),
      Buffer.from([kidBuf.length]),
      kidBuf,
      iv,
      tag,
      enc,
    ]).toString('base64');
  }

  private keyFor(kid: string): Buffer {
    if (kid === this.activeKid) return this.activeKey;
    const prev = this.previousKeys.get(kid);
    if (!prev) {
      throw new Error(`unknown password-vault kid "${kid}"`);
    }
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
    throw new Error('password-vault blob is not valid base64');
  }

  // Minimum: version(1) + kidLen(1) + kid(1+) + iv(12) + tag(16) = 31 bytes.
  if (buf.length < 2 + 1 + IV_LEN + TAG_LEN) {
    throw new Error('password-vault blob is truncated');
  }
  const version = buf.readUInt8(0);
  if (version !== FORMAT_VERSION) {
    throw new Error(`unsupported password-vault blob version 0x${version.toString(16)}`);
  }
  const kidLen = buf.readUInt8(1);
  if (kidLen === 0) {
    throw new Error('password-vault blob has empty kid');
  }
  const kidEnd = 2 + kidLen;
  if (buf.length < kidEnd + IV_LEN + TAG_LEN) {
    throw new Error('password-vault blob is truncated');
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
