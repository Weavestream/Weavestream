import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { EnvService } from '../config/env.service.js';

const ALGO = 'aes-256-gcm';

@Injectable()
export class MfaService {
  constructor(private readonly env: EnvService) {
    authenticator.options = { window: 1, step: 30 };
  }

  generateSecret(): string {
    return authenticator.generateSecret(32);
  }

  otpauthUrl(email: string, secret: string): string {
    return authenticator.keyuri(email, 'Weavestream', secret);
  }

  async qrDataUrl(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
      color: { dark: '#000000', light: '#ffffff' },
    });
  }

  verify(token: string, plaintextSecret: string): boolean {
    try {
      return authenticator.check(token, plaintextSecret);
    } catch {
      return false;
    }
  }

  encryptSecret(secret: string): string {
    const key = Buffer.from(this.env.values.MFA_ENCRYPTION_KEY, 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decryptSecret(payload: string): string {
    const key = Buffer.from(this.env.values.MFA_ENCRYPTION_KEY, 'base64');
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }
}
