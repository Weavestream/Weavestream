import { Injectable } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';
import { AesGcmEnvelope } from './aes-gcm-envelope.js';

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
@Injectable()
export class IntegrationSecretEncryptionService {
  private readonly envelope: AesGcmEnvelope;

  constructor(private readonly env: EnvService) {
    this.envelope = new AesGcmEnvelope({
      activeKey: env.integrationActiveKey,
      activeKid: env.integrationActiveKid,
      previousKeys: env.integrationPreviousKeys,
      keyLabel: 'INTEGRATION_SECRET_KEY',
      previousKeysLabel: 'INTEGRATION_PREVIOUS_KEYS',
      blobLabel: 'integration-secret',
    });
  }

  /** Encrypt plaintext under the active key. Returns base64. */
  encrypt(plaintext: string): string {
    return this.envelope.encrypt(plaintext);
  }

  /** Decrypt base64 blob produced by `encrypt`. Throws on tamper / unknown kid. */
  decrypt(blob: string): string {
    return this.envelope.decrypt(blob);
  }

  /** Re-encrypts under the active kid if the blob was written under an old one. */
  reencryptIfStale(blob: string): { blob: string; rotated: boolean } {
    return this.envelope.reencryptIfStale(blob);
  }

  get currentKid(): string {
    return this.envelope.currentKid;
  }
}
