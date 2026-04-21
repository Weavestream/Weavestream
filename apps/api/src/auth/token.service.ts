import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { EnvService } from '../config/env.service.js';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
  role: string;
}

@Injectable()
export class TokenService {
  constructor(private readonly env: EnvService) {}

  async issueAccessToken(payload: AccessTokenPayload): Promise<string> {
    const ttlSec = this.env.values.ACCESS_TOKEN_TTL_MIN * 60;
    return new SignJWT({ role: payload.role, sid: payload.sid })
      .setProtectedHeader({ alg: 'HS256', kid: this.env.values.JWT_SIGNING_KEY_KID })
      .setSubject(payload.sub)
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .sign(this.env.jwtActiveKey);
  }

  async verifyAccessToken(
    token: string,
  ): Promise<{ sub: string; sid: string; role: string } | null> {
    const candidates: Array<{ kid: string; key: Buffer }> = [
      { kid: this.env.values.JWT_SIGNING_KEY_KID, key: this.env.jwtActiveKey },
      ...this.env.jwtPreviousKeys,
    ];

    // Decode header to find kid before attempting verify with the right key.
    try {
      const header = JSON.parse(
        Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
      ) as { kid?: string };
      const match = candidates.find((c) => c.kid === header.kid) ?? candidates[0];
      const { payload } = await jwtVerify(token, match!.key);
      if (
        typeof payload.sub !== 'string' ||
        typeof payload['sid'] !== 'string' ||
        typeof payload['role'] !== 'string'
      ) {
        return null;
      }
      return { sub: payload.sub, sid: payload['sid'], role: payload['role'] };
    } catch {
      return null;
    }
  }

  mintRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    return { token, hash };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
