import { Injectable } from '@nestjs/common';
import { loadEnv, parsePreviousKeys, type Env } from '@weavestream/shared/server';

@Injectable()
export class EnvService {
  readonly values: Env;
  readonly jwtPreviousKeys: Array<{ kid: string; key: Buffer }>;
  readonly passwordPreviousKeys: Array<{ kid: string; key: Buffer }>;

  constructor() {
    this.values = loadEnv(process.env);
    this.jwtPreviousKeys = parsePreviousKeys(
      this.values.JWT_PREVIOUS_KEYS,
      'JWT_PREVIOUS_KEYS',
    );
    this.passwordPreviousKeys = parsePreviousKeys(
      this.values.PASSWORD_PREVIOUS_KEYS,
      'PASSWORD_PREVIOUS_KEYS',
    );
  }

  get jwtActiveKey(): Buffer {
    return Buffer.from(this.values.JWT_SIGNING_KEY, 'base64');
  }

  get passwordActiveKey(): Buffer {
    return Buffer.from(this.values.PASSWORD_ENCRYPTION_KEY, 'base64');
  }

  get passwordActiveKid(): string {
    return this.values.PASSWORD_ENCRYPTION_KEY_KID;
  }
}
