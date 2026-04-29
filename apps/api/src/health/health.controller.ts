import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { QueueNames } from '@weavestream/shared';
import { Public, SkipCsrf } from '../common/public.decorator.js';
import { AuthedOnly, RequirePermission } from '../rbac/require-permission.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { QueuesService } from '../queues/queues.service.js';

/**
 * Health surface is split along the liveness vs readiness boundary:
 *
 *   • `GET /health`         — public, anonymous. Returns `{ status: 'ok' }`
 *     and nothing else. Designed for orchestrator restart loops + the
 *     compose healthcheck, where the only question is "is this process
 *     alive enough to respond". Deliberately omits version + backend
 *     status to avoid handing version/topology fingerprints to anyone
 *     who can curl the public origin.
 *
 *   • `GET /health/ready`   — authenticated. Probes Postgres + Redis
 *     and surfaces the running version. Returns 200 when fully ready,
 *     503 when a dependency is down. Use this from inside the network
 *     when you actually need to know whether the API can serve work.
 *
 *   • `GET /health/queues`  — authenticated, gated by `audit.read`
 *     (SUPER_ADMIN or AUDIT_READ holder). BullMQ queue counts. Used
 *     by the admin dashboards; the worker liveness probe in
 *     compose.yml runs against the worker's own no-op exec, not this.
 */
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
  liveness() {
    return { status: 'ok' };
  }

  @AuthedOnly()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async readiness() {
    const [pg, rd] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      this.redis.ping(),
    ]);
    const body = {
      status: pg && rd ? ('ok' as const) : ('degraded' as const),
      version: process.env.WEAVESTREAM_VERSION ?? 'dev',
      postgres: pg ? ('ok' as const) : ('down' as const),
      redis: rd ? ('ok' as const) : ('down' as const),
    };
    if (body.status !== 'ok') {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  @RequirePermission('audit.read')
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
