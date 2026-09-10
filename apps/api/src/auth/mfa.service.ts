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

  /**
   * The enrolment QR as an SVG `path` in module units — deliberately not a
   * `data:` PNG.
   *
   * The desktop CSP grants `img-src 'self'` and nothing else, so
   * `<img src="data:image/png;base64,...">` is refused by the browser with a
   * console violation and no other symptom. That is exactly how the setup
   * page shipped: an empty QR frame and a working manual-entry fallback
   * nobody looks at. The alternative to widening `img-src` for one image is
   * an inline `<svg><path d="..."/></svg>`, which is not an image fetch and so
   * is governed by no directive at all.
   *
   * The honest cost: this path runs ~6 KB against the ~3.7 KB base64 PNG it
   * replaces, on a route each account hits once. In exchange the CSP keeps a
   * directive it would otherwise have spent app-wide, and the symbol is
   * resolution-independent instead of a fixed 256 px raster.
   *
   * `size` counts modules *including* the quiet-zone margin, so the caller
   * renders it straight into `viewBox="0 0 size size"`. Error correction and
   * margin match the PNG this replaces, so the symbol itself is unchanged.
   */
  qrMatrix(otpauthUrl: string): { size: number; path: string } {
    const margin = 1;
    const { modules } = QRCode.create(otpauthUrl, { errorCorrectionLevel: 'M' });
    const { size, data } = modules;

    // One filled subpath per horizontal run of dark modules. Runs never
    // overlap, so the default nonzero fill rule needs no thought, and the
    // integer coordinates keep every module edge on a device pixel.
    let path = '';
    for (let row = 0; row < size; row++) {
      let col = 0;
      while (col < size) {
        if (!data[row * size + col]) {
          col++;
          continue;
        }
        const start = col;
        while (col < size && data[row * size + col]) col++;
        const run = col - start;
        path += `M${start + margin} ${row + margin}h${run}v1h-${run}z`;
      }
    }

    return { size: size + margin * 2, path };
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
