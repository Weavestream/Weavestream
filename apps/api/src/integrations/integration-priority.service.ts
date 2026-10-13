import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  resolveIntegrationPriority,
  type IntegrationPriorityDto,
  type UpdateIntegrationPriorityInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';

const SINGLETON_ID = 'singleton';

/**
 * The effective integration priority order (driver keys, highest first).
 * Read once per sync run, so a change takes effect on the next sync.
 */
export async function loadIntegrationPriority(
  prisma: Pick<PrismaService, 'systemSetting'>,
  drivers: Pick<IntegrationDriverRegistry, 'list'>,
): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({
    where: { id: SINGLETON_ID },
    select: { integrationPriority: true },
  });
  return resolveIntegrationPriority(row?.integrationPriority ?? null, drivers.list().map((d) => d.key));
}

/** Admin > Settings > Integrations: "Which integration's values win". */
@Injectable()
export class IntegrationPriorityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly drivers: IntegrationDriverRegistry,
  ) {}

  async get(): Promise<IntegrationPriorityDto> {
    return this.toDto(await loadIntegrationPriority(this.prisma, this.drivers));
  }

  /** The write and its audit row commit together. */
  async update(
    actor: AuthedUser,
    input: UpdateIntegrationPriorityInput,
    meta: { ip: string; userAgent: string },
  ): Promise<IntegrationPriorityDto> {
    const registered = this.drivers.list().map((d) => d.key);
    const unknown = input.order.filter((key) => !registered.includes(key));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown integration: ${unknown.join(', ')}`);
    }
    const order = resolveIntegrationPriority(input.order, registered);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.systemSetting.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID },
        update: {},
        select: { integrationPriority: true },
      });
      await tx.systemSetting.update({
        where: { id: SINGLETON_ID },
        data: { integrationPriority: order as Prisma.InputJsonValue, updatedBy: actor.id },
      });
      await this.audit.logWithClient(tx, {
        actorId: actor.id,
        action: AUDIT_ACTIONS.settings.integrationPriorityUpdate,
        entityType: 'SystemSetting',
        entityId: SINGLETON_ID,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: { order: resolveIntegrationPriority(before.integrationPriority ?? null, registered) },
        after: { order },
      });
    });
    return this.toDto(order);
  }

  private toDto(order: string[]): IntegrationPriorityDto {
    const labels = new Map(this.drivers.list().map((d) => [d.key, d.label]));
    return { order: order.map((key) => ({ key, label: labels.get(key) ?? key })) };
  }
}
