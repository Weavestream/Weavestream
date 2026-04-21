import { Injectable } from '@nestjs/common';
import { loadEnv, parsePreviousKeys, type Env } from '@weavestream/shared/server';

@Injectable()
export class EnvService {
  readonly values: Env;
  readonly jwtPreviousKeys: Array<{ kid: string; key: Buffer }>;

  constructor() {
    this.values = loadEnv(process.env);
    this.jwtPreviousKeys = parsePreviousKeys(this.values.JWT_PREVIOUS_KEYS);
  }

  get jwtActiveKey(): Buffer {
    return Buffer.from(this.values.JWT_SIGNING_KEY, 'base64');
  }
}
