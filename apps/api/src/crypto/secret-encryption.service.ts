import { Injectable } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';
import { AesGcmEnvelope } from './aes-gcm-envelope.js';

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
  private readonly envelope: AesGcmEnvelope;

  constructor(private readonly env: EnvService) {
    this.envelope = new AesGcmEnvelope({
      activeKey: env.passwordActiveKey,
      activeKid: env.passwordActiveKid,
      previousKeys: env.passwordPreviousKeys,
      keyLabel: 'PASSWORD_ENCRYPTION_KEY',
      previousKeysLabel: 'PASSWORD_PREVIOUS_KEYS',
      blobLabel: 'password-vault',
    });
  }

  /**
   * Encrypt plaintext under the currently active key. Returns an opaque
   * base64 string suitable for direct storage in a TEXT column.
   */
  encrypt(plaintext: string): string {
    return this.envelope.encrypt(plaintext);
  }

  /**
   * Decrypt an opaque blob produced by `encrypt` (or a previous kid's
   * equivalent). Throws if the kid is unknown, the ciphertext is
   * tampered, or the format is invalid.
   */
  decrypt(blob: string): string {
    return this.envelope.decrypt(blob);
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
    return this.envelope.reencryptIfStale(blob);
  }

  /**
   * The kid currently issued for new writes. Exposed for CLI progress
   * reporting only; callers MUST NOT make authorization or routing
   * decisions off this value.
   */
  get currentKid(): string {
    return this.envelope.currentKid;
  }
}
