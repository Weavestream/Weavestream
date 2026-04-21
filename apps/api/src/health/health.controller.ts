import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { QueueNames } from '@weavestream/shared';
import { Public, SkipCsrf } from '../common/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { QueuesService } from '../queues/queues.service.js';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueuesService,
  ) {}

  @Public()
  @SkipCsrf()
  @Get()
  async check() {
    const [pg, rd] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      this.redis.ping(),
    ]);
    const ok = pg && rd;
    return {
      status: ok ? 'ok' : 'degraded',
      version: process.env.WEAVESTREAM_VERSION ?? 'dev',
      postgres: pg ? 'ok' : 'down',
      redis: rd ? 'ok' : 'down',
    };
  }

  /**
   * BullMQ queue health. Exposed under `/health/queues` so ops
   * dashboards + the worker's compose healthcheck have a lightweight
   * visibility probe. Returns per-queue counts: `active`, `waiting`,
   * `delayed`, `completed`, `failed`.
   */
  @Public()
  @SkipCsrf()
  @Get('queues')
  async queues_() {
    const out: Record<string, unknown> = {};
    for (const name of Object.values(QueueNames)) {
      try {
        out[name] = await this.queues.getCounts(name);
      } catch (err) {
        out[name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { status: 'ok', queues: out };
  }
}
