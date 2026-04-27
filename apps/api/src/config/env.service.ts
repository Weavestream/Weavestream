import { Injectable } from '@nestjs/common';
import { loadEnv, parsePreviousKeys, type Env } from '@weavestream/shared/server';

@Injectable()
export class EnvService {
  readonly values: Env;
  readonly jwtPreviousKeys: Array<{ kid: string; key: Buffer }>;
  readonly passwordPreviousKeys: Array<{ kid: string; key: Buffer }>;
  readonly integrationPreviousKeys: Array<{ kid: string; key: Buffer }>;
  readonly smtpPreviousKeys: Array<{ kid: string; key: Buffer }>;

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
    this.integrationPreviousKeys = parsePreviousKeys(
      this.values.INTEGRATION_PREVIOUS_KEYS,
      'INTEGRATION_PREVIOUS_KEYS',
    );
    this.smtpPreviousKeys = parsePreviousKeys(
      this.values.SMTP_PREVIOUS_KEYS,
      'SMTP_PREVIOUS_KEYS',
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

  get integrationActiveKey(): Buffer {
    return Buffer.from(this.values.INTEGRATION_SECRET_KEY, 'base64');
  }

  get integrationActiveKid(): string {
    return this.values.INTEGRATION_SECRET_KEY_KID;
  }

  get smtpActiveKey(): Buffer {
    return Buffer.from(this.values.SMTP_SECRET_KEY, 'base64');
  }

  get smtpActiveKid(): string {
    return this.values.SMTP_SECRET_KEY_KID;
  }
}
