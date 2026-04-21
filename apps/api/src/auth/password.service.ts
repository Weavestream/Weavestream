import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { EnvService } from '../config/env.service.js';

@Injectable()
export class PasswordService {
  constructor(private readonly env: EnvService) {}

  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.env.values.ARGON2_MEMORY_KB,
      timeCost: this.env.values.ARGON2_ITERATIONS,
      parallelism: this.env.values.ARGON2_PARALLELISM,
    });
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
