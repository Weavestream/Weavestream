import { Injectable } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';
import { AesGcmEnvelope } from './aes-gcm-envelope.js';

/** Which encrypted column of a Password/PasswordVersion row a blob belongs to. */
export type PasswordVaultField = 'password' | 'totp' | 'notes';

/**
 * AAD for password-vault blobs. Binds a ciphertext to its tenant, its
 * row, and its column: moving a blob across any of the three fails the
 * GCM tag check. `PasswordVersion` rows copy the parent row's
 * ciphertexts verbatim, so they share the parent's `passwordId` AAD —
 * a version blob is still bound to the credential it belongs to.
 *
 * The three components are immutable for the lifetime of a Password
 * row (there is no move-to-other-company path); if such a path is ever
 * added it must decrypt + re-encrypt under the new identity.
 */
export function passwordVaultAad(
  companyId: string,
  passwordId: string,
  field: PasswordVaultField,
): string {
  return `password:${companyId}:${passwordId}:${field}`;
}

/**
 * AAD for the transient PDF-export password that rides through Redis
 * inside the export job payload — bound to the export it was set for.
 */
export function exportPdfPasswordAad(exportId: string): string {
  return `company-export:${exportId}:pdf-password`;
}

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
 *   |  0x02  |   1B    |  N B   | 12B  |  16B   |      ...       |
 *   +--------+---------+--------+------+--------+----------------+
 *
 * `kid` is the key id under which the blob was encrypted. On decrypt we
 * look up the matching key material:
 *   1. If kid === active kid → decrypt with the active key.
 *   2. Else scan PASSWORD_PREVIOUS_KEYS for a matching kid.
 *   3. Else throw.
 *
 * Every blob is additionally bound to its record identity via GCM AAD
 * (see `passwordVaultAad` / `exportPdfPasswordAad`): the tag covers the
 * caller-supplied context string, so a ciphertext relocated to another
 * row, tenant, or field fails authentication instead of decrypting.
 * Version 0x01 blobs predate AAD and remain decryptable until rewrapped.
 *
 * `reencryptIfStale` is called on every write path: if a blob's kid is
 * not the active kid — or it is still a pre-AAD 0x01 blob — it is
 * re-encrypted under the active key. This gives lazy rotation without
 * touching rows that are never updated — a one-shot CLI
 * (`cli reencrypt-passwords`) walks the full tables for operators who
 * want immediate rotation/rebinding.
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
   * Encrypt plaintext under the currently active key, bound to `aad`
   * (build it with `passwordVaultAad`/`exportPdfPasswordAad`). Returns
   * an opaque base64 string suitable for direct storage in a TEXT
   * column.
   */
  encrypt(plaintext: string, aad: string): string {
    return this.envelope.encrypt(plaintext, aad);
  }

  /**
   * Decrypt an opaque blob produced by `encrypt` (or a previous kid's
   * equivalent). `aad` must be the same identity string used on
   * encrypt. Throws if the kid is unknown, the ciphertext is tampered,
   * the AAD does not match, or the format is invalid.
   */
  decrypt(blob: string, aad: string): string {
    return this.envelope.decrypt(blob, aad);
  }

  /**
   * If `blob` was encrypted under a non-active kid or in the pre-AAD
   * 0x01 format, re-encrypt under the current active key bound to
   * `aad` and return the new blob. Otherwise return the blob
   * unchanged. Used on write paths (update) to lazily migrate records
   * after a key rotation or format upgrade.
   *
   * Returns `{ blob, rotated }` — callers that care to count rotations
   * (the CLI) inspect `rotated`.
   */
  reencryptIfStale(blob: string, aad: string): { blob: string; rotated: boolean } {
    return this.envelope.reencryptIfStale(blob, aad);
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
