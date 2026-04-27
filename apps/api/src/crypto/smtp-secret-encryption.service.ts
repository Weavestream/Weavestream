import { Injectable } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';
import { AesGcmEnvelope } from './aes-gcm-envelope.js';

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

  encrypt(plaintext: string): string {
    return this.envelope.encrypt(plaintext);
  }

  decrypt(blob: string): string {
    return this.envelope.decrypt(blob);
  }

  reencryptIfStale(blob: string): { blob: string; rotated: boolean } {
    return this.envelope.reencryptIfStale(blob);
  }

  get currentKid(): string {
    return this.envelope.currentKid;
  }
}
