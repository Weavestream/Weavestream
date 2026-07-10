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

/**
 * AAD for an integration's credential bundle — binds the blob to its
 * `Integration` row so it cannot be relocated onto another integration
 * (or the AI-settings row, which shares this key).
 */
export function integrationSecretAad(integrationId: string): string {
  return `integration:${integrationId}:secret`;
}

/**
 * AAD for the AI-settings API key. `AiSetting` is a singleton row
 * encrypted under the integrations key; the distinct context keeps its
 * blob and integration-secret blobs mutually non-interchangeable.
 */
export const AI_SETTINGS_API_KEY_AAD = 'ai-settings:singleton:api-key';

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

  /** Encrypt plaintext under the active key, bound to `aad`. Returns base64. */
  encrypt(plaintext: string, aad: string): string {
    return this.envelope.encrypt(plaintext, aad);
  }

  /** Decrypt base64 blob produced by `encrypt`. Throws on tamper / AAD mismatch / unknown kid. */
  decrypt(blob: string, aad: string): string {
    return this.envelope.decrypt(blob, aad);
  }

  /** Re-encrypts under the active kid if the blob was written under an old one or pre-AAD. */
  reencryptIfStale(blob: string, aad: string): { blob: string; rotated: boolean } {
    return this.envelope.reencryptIfStale(blob, aad);
  }

  get currentKid(): string {
    return this.envelope.currentKid;
  }
}
