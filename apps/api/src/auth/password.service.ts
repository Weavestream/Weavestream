import { randomBytes } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { EnvService } from '../config/env.service.js';

@Injectable()
export class PasswordService implements OnModuleInit {
  constructor(private readonly env: EnvService) {}

  private dummyHashPromise: Promise<string> | null = null;

  // Fail closed: if the timing-equalization hash cannot be computed, refuse to
  // boot rather than serve logins with an observable fast path (WS-025).
  async onModuleInit(): Promise<void> {
    await this.dummyHash();
  }

  /** Constant-cost hash for timing-equalized verification of non-existent accounts (WS-025). */
  dummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = this.hash(randomBytes(32).toString('hex'));
      // A rejected promise must not be memoized: it would poison every
      // missing-user login with the same rejection. Reset so the next call
      // retries; the rejection itself still propagates to every awaiter.
      this.dummyHashPromise.catch(() => {
        this.dummyHashPromise = null;
      });
    }
    return this.dummyHashPromise;
  }

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
