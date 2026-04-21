import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getTenantContext } from '@weavestream/shared/server';
import { assertTenantScope } from './tenant-scoped-models.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: [{ level: 'warn', emit: 'event' }, { level: 'error', emit: 'event' }] });

    this.$use(async (params, next) => {
      if (params.model) {
        const ctx = getTenantContext();
        // No context = system/CLI/test bench. Allow; out-of-band flows log via
        // AuditLogService directly. Request paths are always wrapped by the
        // TenantContextInterceptor so this branch is only reached from CLI.
        if (ctx) {
          assertTenantScope(
            {
              model: params.model,
              action: params.action,
              args: (params.args ?? {}) as Record<string, unknown>,
            },
            ctx,
          );
        }
      }
      return next(params);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
