import { Injectable } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';
import { AesGcmEnvelope } from './aes-gcm-envelope.js';

/**
 * AAD for the SMTP password. `EmailSetting` is a singleton row, so the
 * context is a constant — it still prevents a blob sealed under this
 * key from being fed to a future second consumer of the SMTP envelope.
 */
export const SMTP_PASSWORD_AAD = 'email-settings:singleton:smtp-password';

@Injectable()
export class SmtpSecretEncryptionService {
  private readonly envelope: AesGcmEnvelope;

  constructor(private readonly env: EnvService) {
    this.envelope = new AesGcmEnvelope({
      activeKey: env.smtpActiveKey,
      activeKid: env.smtpActiveKid,
      previousKeys: env.smtpPreviousKeys,
      keyLabel: 'SMTP_SECRET_KEY',
      previousKeysLabel: 'SMTP_PREVIOUS_KEYS',
      blobLabel: 'smtp-secret',
    });
  }

  encrypt(plaintext: string, aad: string): string {
    return this.envelope.encrypt(plaintext, aad);
  }

  decrypt(blob: string, aad: string): string {
    return this.envelope.decrypt(blob, aad);
  }

  reencryptIfStale(blob: string, aad: string): { blob: string; rotated: boolean } {
    return this.envelope.reencryptIfStale(blob, aad);
  }

  get currentKid(): string {
    return this.envelope.currentKid;
  }
}
