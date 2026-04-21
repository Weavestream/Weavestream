import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EnvService } from '../config/env.service.js';

@Injectable()
export class CsrfService {
  constructor(private readonly env: EnvService) {}

  private key(): Buffer {
    return Buffer.from(this.env.values.CSRF_SIGNING_KEY, 'base64');
  }

  issue(): string {
    const nonce = randomBytes(24).toString('base64url');
    const sig = createHmac('sha256', this.key()).update(nonce).digest('base64url');
    return `${nonce}.${sig}`;
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const [nonce, sig] = token.split('.');
    if (!nonce || !sig) return false;
    const expected = createHmac('sha256', this.key()).update(nonce).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  match(headerToken: string | undefined, cookieToken: string | undefined): boolean {
    if (!headerToken || !cookieToken) return false;
    if (headerToken.length !== cookieToken.length) return false;
    const a = Buffer.from(headerToken);
    const b = Buffer.from(cookieToken);
    return timingSafeEqual(a, b) && this.verify(headerToken);
  }
}
