import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { EnvService } from '../config/env.service.js';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(env: EnvService) {
    this.client = new Redis(env.values.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Return a fresh Redis connection with the option tweaks BullMQ
   * requires for its blocking clients (Worker, QueueEvents). In
   * particular, `maxRetriesPerRequest` MUST be `null` on any client
   * that issues BLPOP/BRPOP — otherwise BullMQ refuses to boot with
   * "Your redis options maxRetriesPerRequest must be null." We also
   * turn off `enableReadyCheck` on the blocking half because BullMQ
   * waits on `ready` itself and the double-check occasionally races
   * during process startup.
   */
  bullmqConnection(): Redis {
    return this.client.duplicate({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
}
